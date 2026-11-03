import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow business APIs, including sentence list/delete, saved audio and window-owned synthesis.
    api: LingoMateApi
  }
}
