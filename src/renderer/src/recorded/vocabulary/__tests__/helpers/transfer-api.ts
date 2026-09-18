import type { VocabularyTransferApi } from '../../../../../../shared/vocabulary-transfer'
export function transferApiStub(): VocabularyTransferApi {
  return {
    downloadTemplate: async () => ({ status: 'cancelled' }),
    exportExcel: async () => ({ status: 'cancelled' }),
    previewExcel: async () => ({ status: 'cancelled' }),
    confirmExcel: async () => ({ status: 'ok', task: null }),
    startImport: async () => ({ status: 'ok', task: null }),
    getImportTask: async () => ({ status: 'ok', task: null }),
    cancelImport: async () => ({ status: 'ok', task: null }),
    onImportProgress: () => () => {}
  }
}
