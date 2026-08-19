/**
 * 会话标题栏入口按钮：会话头部操作区最显眼的「MD 文档」入口。
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { MdvKey } from './locales.ts'
import { setOverlay } from './overlay-store.ts'
import styles from './entry.module.css'

/** 会话头部操作区 owner 为空；组件只消费 locale 标准座。 */
export type HeaderActionProps = PropsLocale<'dsh-md-viewer'>

/** 会话标题栏按钮。 */
export function HeaderAction(props: HeaderActionProps) {
  const t = props.t
  return (
    <button
      type="button"
      className={styles.headerAction}
      title={t('entry.open.title')}
      onClick={() => setOverlay(true)}
    >
      <span aria-hidden>📚</span>
      <span>{t('entry.open.label')}</span>
    </button>
  )
}

/** 供 SlotMap 增强引用的键类型（保证字典键集与 locale 声明一致）。 */
export type { MdvKey }
