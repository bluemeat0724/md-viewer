/**
 * dsh-md-viewer 共享契约：Host 与浏览器半区之间的 JSON 形态（经 /api/mdv/* HTTP）。
 * 只放可 JSON 序列化的叶子数据，不携带任何 Cordis/Harness 活对象。
 */

/** 一次构建的快照元数据（html 本体由 /mdv/<dir> 路由提供，不进 JSON）。 */
export interface SnapshotMeta {
  /** 被扫描目录（绝对路径，同时是快照的键）。 */
  dir: string
  /** 输出文件路径（<dir>/.agent/md-viewer.html）。 */
  outFile: string
  /** iframe/新标签浏览地址（相对路径）。 */
  url: string
  /** 文档数。 */
  fileCount: number
  /** 生成时间（zh-CN 本地化字符串）。 */
  generatedAt: string
  /** 产物大小（MB，两位小数）。 */
  sizeMB: number
  /** 站点标题（目录名）。 */
  title: string
}

/** 工作区摘要（来自 workspaceRegistry，仅叶子字段）。 */
export interface WorkspaceInfo {
  id: string
  title: string
  path: string
}

/** GET /api/mdv/workspaces 响应。 */
export interface WorkspacesResult {
  workspaces: WorkspaceInfo[]
}

/** POST /api/mdv/scan 请求/响应。 */
export interface ScanRequest {
  dir: string
}
export interface ScanResult {
  dir: string
  count: number
  sample: string[]
  error?: string
}

/** POST /api/mdv/build 请求/响应。 */
export interface BuildRequest {
  dir: string
}
export type BuildResult =
  | ({ ok: true } & SnapshotMeta)
  | { ok: false; error: string }

/** GET /api/mdv/status 响应。 */
export interface StatusResult {
  packageFound: boolean
  packagePath: string
  snapshots: SnapshotMeta[]
}
