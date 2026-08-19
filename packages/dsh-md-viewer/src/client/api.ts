/**
 * 浏览器半区的 /api/mdv/* 客户端。唯一数据访问路径：同源 fetch。
 * 错误统一抛 MdvApiError（带服务端 JSON 的 error 字段）。
 */
import type {
  BuildRequest,
  BuildResult,
  ScanRequest,
  ScanResult,
  StatusResult,
  WorkspacesResult,
} from '../protocol.ts'

/** 携带服务端 JSON error 的请求错误。 */
export class MdvApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MdvApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MdvApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new MdvApiError(message)
  }
  return body as T
}

function post<T>(path: string, body: object): Promise<T> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => readJson<T>(res))
}

function get<T>(path: string): Promise<T> {
  return fetch(path).then((res) => readJson<T>(res))
}

/** md-viewer 浏览器 API。 */
export class MdvApi {
  workspaces(): Promise<WorkspacesResult> {
    return get<WorkspacesResult>('/api/mdv/workspaces')
  }

  scan(request: ScanRequest): Promise<ScanResult> {
    return post<ScanResult>('/api/mdv/scan', request)
  }

  build(request: BuildRequest): Promise<BuildResult> {
    return post<BuildResult>('/api/mdv/build', request)
  }

  status(): Promise<StatusResult> {
    return get<StatusResult>('/api/mdv/status')
  }
}
