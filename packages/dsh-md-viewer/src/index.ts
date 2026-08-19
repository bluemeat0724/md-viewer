/**
 * dsh-md-viewer — host half. Mounts the md-viewer engine (in-process reuse of
 * the @bluemeat0724/md-viewer render pipeline), the /api/mdv/* JSON API plus
 * the /mdv/<dir> snapshot route, the agent tools (mdv_build, mdv_status), and
 * a system-prompt announcement. The browser half (./client) renders the
 * viewer overlay. Everything rides official NPM SDK packages — no dsh source
 * changes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'

import { MdViewerEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { mdvBuildTool, mdvStatusTool } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'md-viewer'

/** Services required before the md-viewer surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'workspaceRegistry']

/** Plugin config（组合条目可选配置；未配置时按默认值运行，加载期不校验）。 */
export interface Config {
  /** 是否在系统提示词中向 Agent 宣告本插件（默认 true）。 */
  announceToAgent?: boolean
  /** 总开关：路由/工具/宣告（默认 true）。 */
  enabled?: boolean
}

/** Schema 默认值，apply 里回退用（loader 会在加载时填充 schema 默认值）。 */
const DEFAULT_ANNOUNCE = true
const DEFAULT_ENABLED = true

/** 宣告区段在工具引导带的顺序。 */
const SECTION_ORDER = 160

/** 模型可见宣告：插件存在性、能力与限制。 */
export const MDV_GUIDANCE =
  '本机已安装 dsh-md-viewer 插件（MD 文档查看器）：侧边栏/会话标题栏「MD 文档」入口，用 md-viewer 引擎（marked + highlight.js + mermaid）把工作区 Markdown 渲染为自包含离线快照并内嵌浏览。能力：mdv_build 构建指定目录（缺省会话工作区，产物在 <目录>/.agent/md-viewer.html）、mdv_status 查看已构建快照；构建由用户在 GUI 触发或 Agent 显式调用，以宿主进程权限写入所选目录下一个文件。用户提到「MD 文档 / Markdown 浏览 / md-viewer」时即指本插件，请据此协作。'

/**
 * Mount the engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt/workspaceRegistry.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const value = (): Config => ({
    announceToAgent: config?.announceToAgent ?? DEFAULT_ANNOUNCE,
    enabled: config?.enabled ?? DEFAULT_ENABLED,
  })

  const engine = new MdViewerEngine()
  const listWorkspaces = (): ReturnType<typeof ctx.workspaceRegistry.list> => ctx.workspaceRegistry.list()

  // 路由 + 工具按当前配置同步注册（disposer 分组，重配时先撤旧再注册）。
  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (!value().enabled) return

    if (value().announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-md-viewer',
        order: SECTION_ORDER,
        text: MDV_GUIDANCE,
      })
    }

    const routes = makeRoutes({ engine, listWorkspaces })
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map((route) => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-md-viewer: routes',
    )

    disposeTools = ctx.effect(
      () => {
        const tools = [
          mdvBuildTool(engine, () => {
            const sp = ctx.get('sandboxPolicy')
            try { return sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '' ? sp.workspaceRoot : null } catch { return null }
          }),
          mdvStatusTool(engine),
        ]
        const disposers = tools.map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-md-viewer: tools',
    )
  }

  sync()
}
