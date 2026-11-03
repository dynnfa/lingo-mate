import type { LingoMateApi } from '../shared/conversation'

declare global {
  interface Window {
    // Narrow business APIs, including channel management without credential reads, sentence list/delete and saved audio.
    api: LingoMateApi
  }
}
