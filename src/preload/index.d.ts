import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow business APIs, including window-owned speech synthesis and resource status.
    api: LingoMateApi
  }
}
