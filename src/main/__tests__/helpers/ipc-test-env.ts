import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

// 全部 IPC 模块测试共享的测试脚手架：electron 模块 mock、可信 sender 替身、
// 注册 handler 获取与 mock 重置，替代各测试文件原先逐字复制的相同代码。
// vitest 按文件隔离模块图，每个测试文件拿到的是本文件独立的 mock 实例。

export const RENDERER_URL = 'file:///app/renderer/index.html'

export const electronMocks = {
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn((sender: { owned: boolean }) =>
    sender.owned ? { webContents: sender } : null
  )
}

// vi.mock 工厂随调用提升到文件顶部，不能引用模块级变量；各测试文件用
// vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())
// 引入本组 mock。本文件因此不得导入 ../ipc-guard：其求值会经被 mock 的
// electron 动态回到本模块，形成循环。
export function electronTestModule(): {
  ipcMain: {
    handle: typeof electronMocks.handle
    removeHandler: typeof electronMocks.removeHandler
  }
  BrowserWindow: { fromWebContents: typeof electronMocks.fromWebContents }
} {
  return {
    ipcMain: { handle: electronMocks.handle, removeHandler: electronMocks.removeHandler },
    BrowserWindow: { fromWebContents: electronMocks.fromWebContents }
  }
}

// 可信主 frame 事件的最小形状；显式传 senderFrame 可模拟子 frame 或缺失 frame。
export type IpcHandler = (
  event: { sender: FakeSender; senderFrame?: { url: string } | null },
  input: unknown
) => unknown

// 默认通过信任检查的 WebContents 替身：应用窗口所有、主 frame 指向可信 URL。
// 置 owned=false、把 mainFrame 指向其他 URL 或 destroyed=true 即不再可信；
// send 与 destroy 用于模拟事件推送和窗口销毁。
export class FakeSender extends EventEmitter {
  // 显式 number：子类可覆盖为不同 sender id（限流按 sender 区分）。
  readonly id: number = 7
  owned = true
  destroyed = false
  mainFrame = { url: RENDERER_URL }
  readonly send = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

// 取回某 channel 经注册器注册的 handler；事件未携带 senderFrame 时默认补
// sender 的主 frame，与真实 IPC 调用形状一致。
export function registeredHandler(channel: string): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(([candidate]) => candidate === channel)
  if (!registration) throw new Error(`Missing IPC handler for ${channel}`)
  const handler = registration[1] as IpcHandler
  return (event, input) => handler({ senderFrame: event.sender.mainFrame, ...event }, input)
}

// 测试间重置注册记录；fromWebContents 的默认实现保留，不参与重置。
export function resetIpcMocks(): void {
  electronMocks.handle.mockReset()
  electronMocks.removeHandler.mockReset()
}
