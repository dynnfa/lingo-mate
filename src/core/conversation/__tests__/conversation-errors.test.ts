import { describe, expect, it } from 'vitest'
import { SentenceError } from '../../learning/sentence/sentence-repository'
import { toConversationEventError } from '../conversation-errors'

describe('toConversationEventError', () => {
  it.each([
    ['STORAGE_FAILED', 'PERSISTENCE_ERROR'],
    ['MODEL_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED'],
    ['INVALID_ANALYSIS', 'MODEL_ERROR'],
    ['MODEL_ERROR', 'MODEL_ERROR'],
    ['TIMEOUT', 'MODEL_ERROR']
  ] as const)('maps sentence error %s to %s', (code, expected) => {
    expect(toConversationEventError(new SentenceError(code))).toEqual({ code: expected })
  })
})
