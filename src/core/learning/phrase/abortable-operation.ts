import { createAbortableOperation } from '../abortable-operation'
import { PhraseError } from './parse-phrase-input'

export const abortablePhraseOperation = createAbortableOperation(PhraseError)
