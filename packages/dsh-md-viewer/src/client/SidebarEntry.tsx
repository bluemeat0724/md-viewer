/**
 * 侧边栏底部入口按钮（设置齿轮旁）。owner 提供 { wide }（宽/窄栏状态）。
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { setOverlay } from './overlay-store.ts'
import styles from './entry.module.css'

/** 侧边栏底部按钮 props：owner 的栏宽状态 + locale 标准座。 */
export type SidebarEntryProps = PropsLocale<'dsh-md-viewer'> & { wide: boolean }

/** 侧边栏底部入口按钮：窄栏只显示图标，宽栏显示「MD 文档」。 */
export function SidebarEntry(props: SidebarEntryProps) {
  const t = props.t
  return (
    <button
      type="button"
      className={styles.sidebarEntry}
      title={t('entry.open.title')}
      aria-label={t('entry.open.title')}
      onClick={() => setOverlay(true)}
    >
      <span aria-hidden>📚</span>
      {props.wide ? <span className={styles.sidebarLabel}>{t('entry.open.label')}</span> : null}
    </button>
  )
}
