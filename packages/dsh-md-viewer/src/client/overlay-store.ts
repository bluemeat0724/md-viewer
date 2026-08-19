/**
 * 覆盖层开关的进程内事件总线：会话标题栏按钮 / 侧边栏按钮 / 覆盖层组件共享。
 * 三个入口渲染在各自 slot 里，通过本模块同步开关状态，无需跨组件 prop 钻孔。
 */
import { useEffect, useState } from 'react'

type Listener = (open: boolean) => void

const bus: { open: boolean; listeners: Set<Listener> } = { open: false, listeners: new Set() }

/** 打开/关闭查看器覆盖层，通知所有订阅者。 */
export function setOverlay(open: boolean): void {
  bus.open = !!open
  for (const listener of [...bus.listeners]) {
    try {
      listener(bus.open)
    } catch {
      // 单个订阅者异常不影响其余入口
    }
  }
}

/** 订阅覆盖层开关状态的 React hook。 */
export function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(bus.open)
  useEffect(() => {
    bus.listeners.add(setOpen)
    return () => {
      bus.listeners.delete(setOpen)
    }
  }, [])
  return open
}
