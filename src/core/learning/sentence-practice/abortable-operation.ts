import { createAbortableOperation } from '../abortable-operation'
import { SentencePracticeError } from './parse-sentence-practice-input'

export const abortableOperation = createAbortableOperation(SentencePracticeError)
