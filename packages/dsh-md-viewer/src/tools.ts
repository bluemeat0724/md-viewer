/**
 * dsh-md-viewer 模型工具：与 GUI 共享同一引擎，Agent 可直接构建/查询快照。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { MdViewerEngine } from './engine.ts'
import type { BuildResult, StatusResult } from './protocol.ts'

/** 唯一文本块（这些工具只产出文本渲染）。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 默认目录解析：会话工作区（无则返回 null，由 execute 报错）。 */
export type DefaultDir = () => string | null

/** 构建工具：mdv_build [dir] —— 用 md-viewer 渲染指定目录的 Markdown。 */
export function mdvBuildTool(engine: MdViewerEngine, defaultDir: DefaultDir) {
  return defineTool({
    name: 'mdv_build',
    description: '使用 md-viewer 项目能力，把指定目录下的所有 Markdown 文档渲染成自包含的 md-viewer.html 快照（marked + highlight.js + mermaid，GFM/代码高亮/图表全支持），构建后可在 DeepSeek Harness 界面的「MD 文档」查看器中浏览。目录缺省时使用当前会话工作区。',
    parameters: {
      dir: { type: 'string', description: '要扫描的目录绝对路径（缺省：当前会话工作区）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dir: { type: 'string' },
          outFile: { type: 'string' },
          url: { type: 'string' },
          fileCount: { type: 'integer' },
          generatedAt: { type: 'string' },
          sizeMB: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: BuildResult) => {
        if (value.ok) {
          return text(
            'md-viewer rendered Markdown snapshot\n' +
              `dir: ${value.dir}\nfileCount: ${value.fileCount}\nsize: ${value.sizeMB} MB\n` +
              `generatedAt: ${value.generatedAt}\noutput: ${value.outFile}\nbrowse: ${value.url}\n` +
              'Open the "MD Docs" entry in the Harness GUI to browse the rendered result.',
          )
        }
        return text(`build failed: ${value.error}`)
      },
    },
    async execute(args: { dir?: unknown }) {
      const dir = typeof args?.dir === 'string' && args.dir.trim() !== '' ? args.dir.trim() : defaultDir()
      if (dir === null) {
        return { ok: false, error: 'missing dir and no session workspace available' } satisfies BuildResult
      }
      try {
        const meta = await engine.build(dir)
        return { ok: true, ...meta } satisfies BuildResult
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) } satisfies BuildResult
      }
    },
  })
}

/** 状态工具：mdv_status —— 已构建快照列表与引擎就绪状态。 */
export function mdvStatusTool(engine: MdViewerEngine) {
  return defineTool({
    name: 'mdv_status',
    description: '查看 md-viewer 插件状态：md-viewer 引擎是否就绪、已构建的快照（目录/文档数/大小/生成时间）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          packageFound: { type: 'boolean', required: true },
          packagePath: { type: 'string' },
          snapshots: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dir: { type: 'string', required: true },
                outFile: { type: 'string', required: true },
                url: { type: 'string', required: true },
                fileCount: { type: 'integer', required: true },
                generatedAt: { type: 'string', required: true },
                sizeMB: { type: 'number', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: StatusResult) => {
        const lines = [
          value.packageFound ? 'md-viewer engine: ready' : 'md-viewer engine: missing',
          ...(value.snapshots.length === 0
            ? ['no snapshots yet; run mdv_build or build from the GUI']
            : value.snapshots.map((s) => `${s.title} | ${s.fileCount} docs | ${s.sizeMB} MB | ${s.generatedAt} | ${s.dir}`)),
        ]
        return text(lines.join('\n'))
      },
    },
    execute: async () => engine.status(),
  })
}
