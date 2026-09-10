import { createAbortableOperation } from '../abortable-operation'
import { VocabularyPracticeError } from './parse-vocabulary-practice-input'

export const abortableOperation = createAbortableOperation(VocabularyPracticeError)
