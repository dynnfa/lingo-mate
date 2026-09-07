import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Includes the typed addBatch / cancelBatch / list vocabulary bridge.
    api: LingoMateApi
  }
}
