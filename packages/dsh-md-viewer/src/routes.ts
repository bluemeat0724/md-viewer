/**
 * dsh-md-viewer 路由族：
 * - /api/mdv/*  浏览器半区的 JSON API（workspaces / scan / build / status）
 * - /mdv/<dir>  快照 html（iframe 内嵌浏览；dir 为 encodeURIComponent 的绝对路径）
 *
 * 全部路由带 loopback-only 信任栅栏（同 /api/dsh-ssh 语义）：build 会向用户
 * 选择的目录写入产物，局域网暴露的 dsh web 部署不应提供这些端点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

import type { MdViewerEngine } from './engine.ts'
import type { BuildRequest, ScanRequest, WorkspacesResult } from './protocol.ts'

/** JSON 请求体上限（build/scan 只携带一个目录路径）。 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Loopback 字面量 + 浏览器同源标记（镜像 dsh-ssh 的配对路由栅栏）。 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 统一 JSON 响应。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** 读取 JSON 请求体（超限或解析失败返回 null）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_JSON_BODY_BYTES) return null
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

/** 从请求提取字符串参数（null 表示缺失/类型错误）。 */
function strParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 目录 → 工作区摘要（只取叶子字段）。 */
function summarize(workspaces: readonly Workspace[]): WorkspacesResult {
  return {
    workspaces: workspaces.map((w) => ({ id: String(w.id), title: String(w.title), path: String(w.path) })),
  }
}

/** 构建全部路由。workspaceList 由宿主注入（保持 engine 不依赖 registry）。 */
export function makeRoutes(options: {
  engine: MdViewerEngine
  listWorkspaces: () => readonly Workspace[]
}): WebRoute[] {
  const { engine, listWorkspaces } = options

  const fence = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isLoopbackRequest(req)) return true
    writeJson(res, 403, { error: 'loopback-only' })
    return false
  }

  const api = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): WebRoute => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!fence(req, res)) return
      try {
        await handler(req, res)
      } catch (error) {
        writeJson(res, 500, { error: String((error as Error)?.message ?? error) })
      }
    },
  })

  return [
    api('/api/mdv/workspaces', (_req, res) => {
      writeJson(res, 200, summarize(listWorkspaces()))
    }),

    api('/api/mdv/scan', async (req, res) => {
      const body = (await readJsonBody(req)) as ScanRequest | null
      const dir = strParam(body?.dir)
      if (dir === null) {
        writeJson(res, 400, { error: 'missing dir' })
        return
      }
      writeJson(res, 200, await engine.scan(dir))
    }),

    api('/api/mdv/build', async (req, res) => {
      const body = (await readJsonBody(req)) as BuildRequest | null
      const dir = strParam(body?.dir)
      if (dir === null) {
        writeJson(res, 400, { error: 'missing dir' })
        return
      }
      try {
        writeJson(res, 200, { ok: true, ...(await engine.build(dir)) })
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String((error as Error)?.message ?? error) })
      }
    }),

    api('/api/mdv/status', (_req, res) => {
      writeJson(res, 200, engine.status())
    }),

    // 快照 html（iframe 浏览）：/mdv/<encodeURIComponent(dir)>
    {
      kind: 'prefix',
      path: '/mdv',
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('loopback-only')
          return
        }
        let dir: string | null = null
        try {
          const raw = (req.url ?? '/').split('?')[0]
          if (raw.startsWith('/mdv/')) dir = decodeURIComponent(raw.slice('/mdv/'.length))
        } catch {
          dir = null
        }
        const html = dir === null ? undefined : engine.htmlFor(dir)
        if (html === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('md-viewer snapshot not found; build it first via the MD viewer panel.')
          return
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(html)
      },
    },
  ]
}
