/**
 * 全屏查看器覆盖层（shell.overlay）：工作区列表 + 构建 + iframe 内嵌预览。
 *
 * 数据全部走 /api/mdv/*（Host 引擎），iframe 指向 /mdv/<dir> 快照路由。
 * 覆盖层关闭时返回 null（不参与指针事件）；重新打开保留上次快照。
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { MdvApi } from './api.ts'
import type { BuildResult, SnapshotMeta, StatusResult, WorkspaceInfo } from '../protocol.ts'
import { useOverlayOpen, setOverlay } from './overlay-store.ts'
import styles from './viewer.module.css'

/** 覆盖层 owner 为空；组件只消费 locale 标准座。 */
export type ViewerOverlayProps = PropsLocale<'dsh-md-viewer'>

/** 当前预览快照（url 随 key 变更强制 iframe 重新加载）。 */
interface ActiveSnapshot {
  url: string
  title: string
  key: string
}

/** 打开中的覆盖层内容。 */
function ViewerPanel(props: ViewerOverlayProps) {
  const t = props.t
  const api = useRef(new MdvApi()).current

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [status, setStatus] = useState<StatusResult | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const scanned = useRef<Record<string, boolean>>({})
  const [customDir, setCustomDir] = useState('')
  const [building, setBuilding] = useState(false)
  const [active, setActive] = useState<ActiveSnapshot | null>(null)
  const [message, setMessage] = useState('')

  // 打开时加载工作区与状态；已有快照则直接进入预览。
  useEffect(() => {
    let alive = true
    setMessage(t('overlay.loading'))
    Promise.all([api.workspaces().catch(() => ({ workspaces: [] })), api.status().catch(() => null)])
      .then(([ws, st]) => {
        if (!alive) return
        const list = ws.workspaces
        setWorkspaces(list)
        setStatus(st)
        const snap = st?.snapshots[0]
        if (snap !== undefined) {
          setActive({ url: snap.url, title: snap.title, key: snap.dir + ':' + snap.generatedAt })
          setMessage(t('overlay.buildOk', { count: snap.fileCount, size: snap.sizeMB, time: snap.generatedAt, file: snap.outFile }))
        } else if (list.length > 0) {
          setCustomDir(list[0].path)
          setMessage(t('overlay.emptyHint'))
        } else {
          setMessage(t('overlay.noWorkspaces'))
        }
      })
    return () => {
      alive = false
    }
  }, [api, t])

  // 工作区加载后异步补齐各目录 md 数量。
  useEffect(() => {
    if (workspaces.length === 0) return
    let alive = true
    for (const ws of workspaces) {
      if (scanned.current[ws.path]) continue
      scanned.current[ws.path] = true
      api.scan({ dir: ws.path }).then((r) => {
        if (!alive) return
        if (typeof r.count === 'number') {
          setCounts((prev) => ({ ...prev, [ws.path]: r.count }))
        }
      }).catch(() => { /* 目录可能已不存在，忽略 */ })
    }
    return () => {
      alive = false
    }
  }, [api, workspaces])

  /** 构建指定目录并刷新预览。 */
  const build = (dir: string): void => {
    if (dir === '' || building) return
    setBuilding(true)
    setMessage(t('overlay.buildingHint', { dir }))
    api.build({ dir }).then((result: BuildResult) => {
      setBuilding(false)
      if (result.ok) {
        const snap: SnapshotMeta = result
        setActive({ url: snap.url, title: snap.title, key: snap.dir + ':' + Date.now() })
        setCounts((prev) => ({ ...prev, [snap.dir]: snap.fileCount }))
        setMessage(t('overlay.buildOk', { count: snap.fileCount, size: snap.sizeMB, time: snap.generatedAt, file: snap.outFile }))
      } else {
        setMessage(t('overlay.buildFail', { error: result.error }))
      }
    }).catch((error: unknown) => {
      setBuilding(false)
      setMessage(t('overlay.buildFail', { error: error instanceof Error ? error.message : String(error) }))
    })
  }

  const rows = workspaces.map((ws) => {
    const count = counts[ws.path]
    const activeClass = active !== null && active.url.endsWith(encodeURIComponent(ws.path)) ? ` ${styles.workspaceActive}` : ''
    return (
      <div
        key={ws.id}
        className={styles.workspace + activeClass}
        onClick={() => setCustomDir(ws.path)}
      >
        <div className={styles.wsTitleRow}>
          <span className={styles.wsTitle}>{ws.title}</span>
          <span className={styles.badge}>{count !== undefined ? `${count} md` : t('overlay.scanning')}</span>
        </div>
        <div className={styles.wsPath}>{ws.path}</div>
        <div className={styles.wsActions}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={(event) => {
              event.stopPropagation()
              build(ws.path)
            }}
            disabled={building}
          >
            {building ? t('overlay.building') : t('overlay.buildAndPreview')}
          </button>
          {active !== null ? (
            <button
              type="button"
              className={styles.button}
              onClick={(event) => {
                event.stopPropagation()
                window.open(active.url, '_blank', 'noopener')
              }}
            >
              {t('overlay.openInTab')}
            </button>
          ) : null}
        </div>
      </div>
    )
  })

  return (
    <div className={styles.overlay}>
      <div className={styles.head}>
        <h3 className={styles.title}>📚 {t('overlay.title')}</h3>
        <div className={styles.tools}>
          <input
            className={styles.dirInput}
            type="text"
            value={customDir}
            placeholder={t('overlay.customDirPlaceholder')}
            onChange={(event) => setCustomDir(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') build(customDir.trim())
            }}
          />
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => build(customDir.trim())}
            disabled={building || customDir.trim() === ''}
          >
            {building ? t('overlay.building') : t('overlay.buildAndPreview')}
          </button>
          {status?.packageFound ? (
            <span className={`${styles.badge} ${styles.badgeOk}`} title={status.packagePath ?? ''}>
              {t('overlay.badgeReady')}
            </span>
          ) : (
            <span className={styles.badge}>{t('overlay.badgeMissing')}</span>
          )}
        </div>
        <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => setOverlay(false)}>
          ✕ {t('overlay.close')}
        </button>
      </div>
      <div className={styles.body}>
        <div className={styles.side}>
          <div className={styles.sideTitle}>{t('overlay.workspaces')}</div>
          {rows.length > 0 ? rows : <div className={styles.empty}>{t('overlay.noWorkspaces')}</div>}
        </div>
        <div className={styles.frameWrap}>
          {active !== null ? (
            <iframe className={styles.frame} key={active.key} src={active.url} title={active.title} />
          ) : (
            <div className={styles.empty}>{t('overlay.emptyHint')}</div>
          )}
        </div>
      </div>
      <div className={styles.status}>{message}</div>
    </div>
  )
}

/** 覆盖层入口：未打开时不渲染（返回 null），打开时渲染 ViewerPanel。 */
export function ViewerOverlay(props: ViewerOverlayProps) {
  const open = useOverlayOpen()
  return open ? <ViewerPanel {...props} /> : null
}
