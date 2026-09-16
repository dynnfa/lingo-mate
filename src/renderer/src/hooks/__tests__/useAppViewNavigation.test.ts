// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppViewNavigation, type SecondaryView } from '../useAppViewNavigation'

// hook 不渲染按钮本身，测试把真实按钮元素挂到 body 并写入 ref，
// 用 document.activeElement / focus spy 验证焦点行为。
function mountEntryButton(view: SecondaryView): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.entry = view
  document.body.appendChild(button)
  return button
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useAppViewNavigation', () => {
  it('starts on conversation without stealing focus on mount', () => {
    mountEntryButton('settings')
    mountEntryButton('recorded')
    mountEntryButton('practice')

    const { result } = renderHook(() => useAppViewNavigation())

    expect(result.current.activeView).toBe('conversation')
    expect(document.activeElement).toBe(document.body)
  })

  it('opens a secondary view', () => {
    const { result } = renderHook(() => useAppViewNavigation())

    act(() => result.current.openView('recorded'))

    expect(result.current.activeView).toBe('recorded')
  })

  it.each(['settings', 'recorded', 'practice'] as const satisfies readonly SecondaryView[])(
    'returns focus to the %s entry button on returnToConversation',
    (view) => {
      const { result } = renderHook(() => useAppViewNavigation())
      const entryButton = mountEntryButton(view)
      result.current.entryButtonRefs[view].current = entryButton

      act(() => result.current.openView(view))
      act(() => result.current.returnToConversation())

      expect(result.current.activeView).toBe('conversation')
      expect(document.activeElement).toBe(entryButton)
    }
  )

  it('does not focus while a secondary view stays open', () => {
    const { result } = renderHook(() => useAppViewNavigation())
    const settingsButton = mountEntryButton('settings')
    result.current.entryButtonRefs.settings.current = settingsButton
    const focusSpy = vi.spyOn(settingsButton, 'focus')

    act(() => result.current.openView('settings'))
    act(() => result.current.openView('recorded'))

    expect(result.current.activeView).toBe('recorded')
    expect(focusSpy).not.toHaveBeenCalled()
  })
})
