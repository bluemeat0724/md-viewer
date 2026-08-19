/**
 * dsh-md-viewer 引擎：进程内复用 @bluemeat0724/md-viewer 的渲染管线
 * （marked + highlight.js + mermaid → 自包含 md-viewer.html）。
 *
 * 与 CLI 不同，这里不 spawn 子进程：直接调用包的程序化 API
 * （build / findMds），写入使用宿主进程权限——构建是用户在 GUI 主动触发的、
 * 只写所选目录下 <dir>/.agent/md-viewer.html 一个文件（安全模型见 README）。
 */
import { build as buildHtml, findMds } from '@bluemeat0724/md-viewer'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import type { ScanResult, SnapshotMeta, StatusResult } from './protocol.ts'

/** 快照内存账本：dir -> meta + html（html 供 /mdv/<dir> 路由直接返回）。 */
interface SnapshotEntry extends SnapshotMeta {
  html: string
}

const require = createRequire(import.meta.url)

export class MdViewerEngine {
  private snapshots = new Map<string, SnapshotEntry>()

  /** md-viewer 包安装位置（status 展示用；构建直接 import，不依赖该路径解析）。 */
  packagePath(): string {
    try {
      return dirname(require.resolve('@bluemeat0724/md-viewer/package.json'))
    } catch {
      return ''
    }
  }

  /** 递归统计目录下 md 文件（引擎同款跳过规则：隐藏项 + 依赖/产物目录）。 */
  async scan(dir: string): Promise<ScanResult> {
    try {
      const rels = await findMds(dir)
      return { dir, count: rels.length, sample: rels.slice(0, 100) }
    } catch (error) {
      return { dir, count: 0, sample: [], error: String((error as Error)?.message ?? error) }
    }
  }

  /** 构建并缓存快照。写入失败/目录不存在时抛错（由路由层转 JSON 错误）。 */
  async build(dir: string): Promise<SnapshotMeta> {
    const outFile = join(dir, '.agent', 'md-viewer.html')
    const title = basename(dir) || dir
    await buildHtml({ srcDir: dir, outFile, title })
    const html = await readFile(outFile, 'utf8')
    const rels = await findMds(dir)
    const meta: SnapshotMeta = {
      dir,
      outFile,
      url: '/mdv/' + encodeURIComponent(dir),
      fileCount: rels.length,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      sizeMB: Number((Buffer.byteLength(html, 'utf8') / 1048576).toFixed(2)),
      title,
    }
    this.snapshots.set(dir, { ...meta, html })
    return meta
  }

  /** 已构建快照列表（不含 html 本体）。 */
  status(): StatusResult {
    return {
      packageFound: this.packagePath() !== '',
      packagePath: this.packagePath(),
      snapshots: Array.from(this.snapshots.values()).map(({ html: _html, ...meta }) => meta),
    }
  }

  /** 指定目录的快照 html（无快照返回 undefined）。 */
  htmlFor(dir: string): string | undefined {
    return this.snapshots.get(dir)?.html
  }
}
