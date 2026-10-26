import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow business APIs, including saved conversation audio and window-owned synthesis.
    api: LingoMateApi
  }
}
