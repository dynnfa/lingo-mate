import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

// 应用顶层视图：conversation 为常驻主视图，其余为全屏子页面。
export type AppView = 'conversation' | 'settings' | 'recorded' | 'practice' | 'mistakes'

// 可通过入口按钮主动打开的子页面视图。
export type SecondaryView = Exclude<AppView, 'conversation'>

export interface AppViewNavigation {
  /** 当前激活视图，初始为 'conversation' */
  activeView: AppView
  /** 打开一个子页面视图 */
  openView: (view: SecondaryView) => void
  /** 返回对话视图（供子页面 onExit 调用） */
  returnToConversation: () => void
  /** 入口按钮的 ref，由 App.tsx 绑定到侧栏按钮 */
  entryButtonRefs: {
    settings: RefObject<HTMLButtonElement | null>
    recorded: RefObject<HTMLButtonElement | null>
    practice: RefObject<HTMLButtonElement | null>
    mistakes: RefObject<HTMLButtonElement | null>
  }
}

// 视图切换与焦点恢复状态机：从子页面回到对话视图时，把焦点还给
// 打开该子页面的入口按钮。
export function useAppViewNavigation(): AppViewNavigation {
  const [activeView, setActiveView] = useState<AppView>('conversation')
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const recordedButtonRef = useRef<HTMLButtonElement>(null)
  const practiceButtonRef = useRef<HTMLButtonElement>(null)
  const mistakesButtonRef = useRef<HTMLButtonElement>(null)
  const previousViewRef = useRef<AppView>('conversation')

  // refs 对象在渲染间保持稳定引用，调用方可安全用于 effect 依赖。
  const entryButtonRefs = useMemo(
    () => ({
      settings: settingsButtonRef,
      recorded: recordedButtonRef,
      practice: practiceButtonRef,
      mistakes: mistakesButtonRef
    }),
    [settingsButtonRef, recordedButtonRef, practiceButtonRef, mistakesButtonRef]
  )

  // 从子页面返回对话视图时，把焦点还给对应入口按钮；初次挂载不抢焦点。
  useEffect(() => {
    const previousView = previousViewRef.current
    if (activeView === 'conversation' && previousView !== 'conversation') {
      entryButtonRefs[previousView].current?.focus()
    }
    previousViewRef.current = activeView
  }, [activeView, entryButtonRefs])

  const openView = (view: SecondaryView): void => {
    setActiveView(view)
  }

  const returnToConversation = (): void => {
    setActiveView('conversation')
  }

  return { activeView, openView, returnToConversation, entryButtonRefs }
}
