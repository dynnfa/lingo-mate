import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    api: LingoMateApi
  }
}
