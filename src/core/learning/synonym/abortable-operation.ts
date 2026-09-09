import { createAbortableOperation } from '../abortable-operation'
import { SynonymError } from './parse-synonym-input'

export const abortableSynonymOperation = createAbortableOperation(SynonymError)
