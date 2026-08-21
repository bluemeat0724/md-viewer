/**
 * MdViewerEngine 单测：进程内复用 @bluemeat0724/md-viewer 构建管线的
 * 扫描 / 构建 / 快照提供 全链路。
 * 0.7.0 起快照存文档原始文本（md/json 双类型），产物在 .agents/md-viewer/。
 */
import { describe, expect, it } from 'vitest'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MdViewerEngine } from '../src/engine.ts'

/** 构造临时文档目录并返回其路径。 */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mdv-test-'))
  await mkdir(join(dir, 'docs'), { recursive: true })
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(join(dir, 'README.md'), ['# 项目说明', '', '内部链接：[子文档](docs/child.md)。', '', '```js', 'const x = 1;', '```', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n'))
  await writeFile(join(dir, 'docs', 'child.md'), '# 子文档\n\n## 小节\n\n正文。\n')
  await writeFile(join(dir, 'data', 'config.json'), '{"name":"dsh","list":[1,2]}')
  return dir
}

describe('MdViewerEngine', () => {
  it('scan 统计目录下 md/json 文件（含子目录）', async () => {
    const dir = await fixture()
    try {
      const engine = new MdViewerEngine()
      const result = await engine.scan(dir)
      expect(result.count).toBe(3)
      expect(result.sample.sort()).toEqual(['README.md', 'data/config.json', 'docs/child.md'])
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

  it('build 生成快照并可提供 html（原始文本快照 + 按需 bundle）', async () => {
    const dir = await fixture()
    try {
      const engine = new MdViewerEngine()
      const meta = await engine.build(dir)

      expect(meta.dir).toBe(dir)
      expect(meta.outFile).toBe(join(dir, '.agents', 'md-viewer', 'index.html'))
      expect(meta.url).toBe('/mdv/' + encodeURIComponent(dir))
      expect(meta.fileCount).toBe(2)
      expect(meta.jsonCount).toBe(1)
      expect(meta.sizeMB).toBeGreaterThan(0)

      const html = engine.htmlFor(dir)
      expect(html).toBeDefined()
      // 页面级：共享渲染核心已内联
      expect(html).toContain('MDV_CORE')
      // 文档快照在 <script type="application/json" id="mdv-data"> 里（< 已转义）
      const payload = /<script type="application\/json" id="mdv-data">([\s\S]*?)<\/script>/.exec(html ?? '')
      expect(payload).not.toBeNull()
      const docs = JSON.parse(payload![1]) as Array<{ path: string; type: string; raw: string }>
      expect(docs).toHaveLength(3)
      const readme = docs.find((d) => d.path === 'README.md')
      const config = docs.find((d) => d.path === 'data/config.json')
      expect(readme).toBeDefined()
      expect(readme!.type).toBe('md')
      // 快照存原始文本；渲染（高亮/mermaid/链接重写）在浏览器端按需执行
      expect(readme!.raw).toContain('# 项目说明')
      expect(readme!.raw).not.toContain('class="language-js hljs"')
      expect(config!.type).toBe('json')
      expect(config!.raw).toBe('{"name":"dsh","list":[1,2]}')
      // 依赖 bundle 按需内嵌（fixture 含 md 与 mermaid → 三者俱全）
      expect(/window\.marked\s*=/.test(html ?? '')).toBe(true)
      expect(/window\.hljs\s*=/.test(html ?? '')).toBe(true)
      expect(html).toContain('<script type="text/plain" id="mermaid-src">')

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

  it('build 顺带清理 0.6.x 的单文件产物 .agents/md-viewer.html', async () => {
    const dir = await fixture()
    try {
      const legacy = join(dir, '.agents', 'md-viewer.html')
      await mkdir(join(dir, '.agents'), { recursive: true })
      await writeFile(legacy, 'old artifact')
      const engine = new MdViewerEngine()
      await engine.build(dir)
      await expect(access(legacy)).rejects.toThrow()
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
