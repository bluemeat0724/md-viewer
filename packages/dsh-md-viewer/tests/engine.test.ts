/**
 * MdViewerEngine 单测：进程内复用 @bluemeat0724/md-viewer 渲染管线的
 * 扫描 / 构建 / 快照提供 全链路。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MdViewerEngine } from '../src/engine.ts'

/** 构造临时文档目录并返回其路径。 */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mdv-test-'))
  await mkdir(join(dir, 'docs'), { recursive: true })
  await writeFile(join(dir, 'README.md'), ['# 项目说明', '', '内部链接：[子文档](docs/child.md)。', '', '```js', 'const x = 1;', '```', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n'))
  await writeFile(join(dir, 'docs', 'child.md'), '# 子文档\n\n## 小节\n\n正文。\n')
  return dir
}

describe('MdViewerEngine', () => {
  it('scan 统计目录下 md 文件（含子目录）', async () => {
    const dir = await fixture()
    try {
      const engine = new MdViewerEngine()
      const result = await engine.scan(dir)
      expect(result.count).toBe(2)
      expect(result.sample.sort()).toEqual(['README.md', 'docs/child.md'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scan 对不存在目录返回 0 而非抛错', async () => {
    const engine = new MdViewerEngine()
    const result = await engine.scan('/nonexistent/path/for/dsh-md-viewer-test')
    expect(result.count).toBe(0)
    expect(result.error).toBeDefined()
  })

  it('build 生成快照并可提供 html（含渲染内容与 mermaid 还原）', async () => {
    const dir = await fixture()
    try {
      const engine = new MdViewerEngine()
      const meta = await engine.build(dir)

      expect(meta.dir).toBe(dir)
      expect(meta.outFile).toBe(join(dir, '.agents', 'md-viewer.html'))
      expect(meta.url).toBe('/mdv/' + encodeURIComponent(dir))
      expect(meta.fileCount).toBe(2)
      expect(meta.sizeMB).toBeGreaterThan(0)

      const html = engine.htmlFor(dir)
      expect(html).toBeDefined()
      // 页面级：共享渲染核心已内联
      expect(html).toContain('MDV_CORE')
      // 文档内容在 SNAPSHOT JSON payload 里（< 与 " 被 JSON 转义），解析后断言
      const payload = /var SNAPSHOT = ([\s\S]*?);\s*var SITE_TITLE/.exec(html ?? '')
      expect(payload).not.toBeNull()
      const docs = JSON.parse(payload![1]) as Array<{ path: string; html: string }>
      expect(docs).toHaveLength(2)
      const readme = docs.find((d) => d.path === 'README.md')
      expect(readme).toBeDefined()
      expect(readme!.html).toContain('class="language-js hljs"')
      expect(readme!.html).toContain('<pre class="mermaid">graph TD; A--&gt;B;</pre>')
      expect(readme!.html).toContain('<a href="#doc-docs-child">子文档</a>')

      // status 含该快照（不含 html 本体）
      const status = engine.status()
      expect(status.packageFound).toBe(true)
      expect(status.packagePath).not.toBe('')
      expect(status.snapshots).toHaveLength(1)
      expect(status.snapshots[0].dir).toBe(dir)
      expect((status.snapshots[0] as { html?: unknown }).html).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('重复 build 同一目录会覆盖快照（最近一次为准）', async () => {
    const dir = await fixture()
    try {
      const engine = new MdViewerEngine()
      await engine.build(dir)
      const meta = await engine.build(dir)
      expect(meta.generatedAt).toBeDefined()
      expect(engine.status().snapshots).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('htmlFor 对未构建目录返回 undefined', () => {
    const engine = new MdViewerEngine()
    expect(engine.htmlFor('/some/unbuilt/dir')).toBeUndefined()
  })
})
