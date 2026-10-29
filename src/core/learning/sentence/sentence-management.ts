import {
  listSentenceInputSchema,
  deleteSentenceInputSchema,
  type SentencePage,
  type ListSentenceInput
} from '../../../shared/sentence'
import type { SentenceRepository } from './sentence-repository'
export class SentenceManagementService {
  constructor(private readonly repository: SentenceRepository) {}
  list(raw: ListSentenceInput): SentencePage {
    return this.repository.list(listSentenceInputSchema.parse(raw))
  }
  delete(raw: { id: string }): { id: string; deleted: boolean } {
    const { id } = deleteSentenceInputSchema.parse(raw)
    return { id, deleted: this.repository.delete(id) }
  }
}
