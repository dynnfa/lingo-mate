import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow, typed business APIs, including window-owned vocabulary imports and progress.
    api: LingoMateApi
  }
}
