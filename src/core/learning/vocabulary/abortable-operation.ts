import { createAbortableOperation } from '../abortable-operation'
import { VocabularyError } from './parse-vocabulary-input'

export const abortableOperation = createAbortableOperation(VocabularyError)
