import { useEffect, type RefObject } from 'react'

export interface FocusTrapOptions {
  // 陷阱仅在激活期间接管键盘焦点；失活（对话框关闭）时归还焦点。
  active: boolean
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
}

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

// 对话框焦点陷阱：激活时聚焦初始元素，Tab/Shift+Tab 在容器内循环，
// 失活时把焦点归还 returnFocusRef 指向的元素。零依赖，仅 DOM API。
export function useFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  returnFocusRef
}: FocusTrapOptions): void {
  useEffect(() => {
    if (!active) return
    initialFocusRef.current?.focus()
    return () => {
      // 刻意在关闭时读取最新指向：归还目标可能在对话框打开期间被重渲染替换，
      // 引用已脱离 DOM 的节点时 focus 为无害空操作。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      returnFocusRef?.current?.focus()
    }
  }, [active, initialFocusRef, returnFocusRef])

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement
      if (event.shiftKey) {
        if (current === first || !container.contains(current)) {
          event.preventDefault()
          last.focus()
        }
      } else if (current === last || !container.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, containerRef])
}
