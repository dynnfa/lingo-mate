import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow, typed business APIs exposed by preload.
    api: LingoMateApi
  }
}
