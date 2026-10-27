import { expect, it } from 'vitest'
import { createAgentSnapshot, type AgentTask } from '../agent-runtime'
import { getAgentTaskPolicy } from '../agent-task-policy'

const cases = [
  [
    'conversation',
    [120000, 3, 2, 16, 32768, 32768],
    ['model.reply'],
    'result',
    'stream',
    1,
    undefined
  ],
  [
    'conversation-title',
    [120000, 1, 0, 1, 32768, 80],
    ['model.title'],
    'result',
    'stream',
    1,
    undefined
  ],
  [
    'tool-loop',
    [120000, 3, 2, 16, 32768, 32768],
    ['model.decide', 'learning.lookup'],
    'result',
    'stream',
    1,
    undefined
  ],
  [
    'vocabulary',
    [180000, 20, 2, 32, 32768, 32768],
    ['vocabulary.prepare', 'model.vocabulary'],
    'vocabulary_result',
    'none',
    2,
    'model.vocabulary'
  ],
  [
    'phrase',
    [180000, 20, 2, 32, 32768, 32768],
    ['phrase.prepare', 'model.phrase'],
    'phrase_result',
    'none',
    2,
    'model.phrase'
  ],
  [
    'synonym',
    [180000, 1040, 1061, 2200, 65536, 524288],
    ['synonym.prepare', 'model.synonym', 'synonym.apply', 'synonym.finish'],
    'synonym_result',
    'none',
    1,
    undefined
  ],
  [
    'explore-phrase',
    [180000, 3, 1, 8, 65536, 32768],
    ['explore-phrase.prepare', 'model.explore-phrase'],
    'explore_phrase_result',
    'none',
    1,
    undefined
  ],
  [
    'explore-vocabulary',
    [180000, 3, 1, 8, 65536, 32768],
    ['explore-vocabulary.prepare', 'model.explore-vocabulary'],
    'explore_vocabulary_result',
    'none',
    1,
    undefined
  ],
  [
    'sentence-practice-hints',
    [120000, 1, 1, 2, 65536, 1024],
    ['sentence-practice.prepare', 'model.sentence-practice-hints'],
    'sentence_practice_result',
    'none',
    1,
    undefined
  ],
  [
    'sentence-practice-review',
    [120000, 1, 1, 2, 65536, 1024],
    ['sentence-practice.prepare', 'model.sentence-practice-review'],
    'sentence_practice_result',
    'none',
    1,
    undefined
  ],
  [
    'vocabulary-practice-review',
    [120000, 8, 10, 18, 65536, 4096],
    [
      'vocabulary-practice.prepare',
      'model.vocabulary-practice-review',
      'vocabulary-practice.apply',
      'vocabulary-practice.correct',
      'vocabulary-practice.finish'
    ],
    'vocabulary_practice_result',
    'none',
    1,
    undefined
  ],
  ['tts', [180000, 0, 1, 1, 4096, 1024], ['tts.synthesize'], 'tts_result', 'none', 1, undefined]
] as const

it.each(cases)(
  'preserves the fixed permissions, budgets and runtime rules for %s',
  (task, values, operations, successFrame, events, max, operation) => {
    const [timeoutMs, maxModelCalls, maxToolCalls, maxSteps, maxInputChars, maxOutputChars] = values
    const budget = {
      timeoutMs,
      maxModelCalls,
      maxToolCalls,
      maxSteps,
      maxInputChars,
      maxOutputChars
    }
    const policy = getAgentTaskPolicy(task)
    const snapshot = createAgentSnapshot({
      task,
      messages: [{ role: 'user', content: 'hello' }],
      outputLanguage: 'en',
      targetLanguage: 'en'
    })
    expect(policy).toEqual({
      budget,
      allowedOperations: operations,
      successFrame,
      events,
      concurrency: operation ? { max, operation } : { max }
    })
    expect(snapshot.budget).toEqual(budget)
    expect(snapshot.allowedOperations).toEqual(operations)
  }
)

it.each(cases)('isolates policy and snapshot mutations across %s runs', (task) => {
  const input: AgentTask = {
    task,
    messages: [{ role: 'user', content: 'hello' }],
    outputLanguage: 'en',
    targetLanguage: 'en'
  }
  const expected = createAgentSnapshot(input)
  const policy = getAgentTaskPolicy(task)
  Reflect.set(policy.budget, 'maxOutputChars', 1)
  Reflect.set(policy.allowedOperations, '0', 'learning.lookup')
  Reflect.set(policy.concurrency, 'max', 20)
  const changed = createAgentSnapshot(input)
  changed.budget.maxOutputChars = 2
  changed.messages[0].content = 'changed'
  Reflect.set(changed.allowedOperations, '0', 'learning.lookup')
  expect(createAgentSnapshot(input)).toEqual(expected)
  expect(getAgentTaskPolicy(task).budget).toEqual(expected.budget)
  expect(input.messages[0].content).toBe('hello')
})
