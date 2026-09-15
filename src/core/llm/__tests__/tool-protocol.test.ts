import { describe, expect, it } from 'vitest'
import { isUnsupportedToolCall, parseSingleToolCallResponse } from '../tool-protocol'

function toolCall(name: string, args: string): Record<string, unknown> {
  return { id: 'call_1', type: 'function', function: { name, arguments: args } }
}

function completion(
  overrides: {
    finishReason?: unknown
    content?: unknown
    refusal?: unknown
    toolCalls?: unknown
  } = {}
): Record<string, unknown> {
  const message: Record<string, unknown> = {}
  if ('content' in overrides) message.content = overrides.content
  if ('refusal' in overrides) message.refusal = overrides.refusal
  if ('toolCalls' in overrides) message.tool_calls = overrides.toolCalls
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'finishReason' in overrides ? overrides.finishReason : 'tool_calls',
        message
      }
    ]
  }
}

const singleCall = completion({ toolCalls: [toolCall('insert_vocabulary', '{"term":"apple"}')] })

describe('parseSingleToolCallResponse', () => {
  it('returns the tool name and parsed arguments', () => {
    expect(parseSingleToolCallResponse(singleCall)).toEqual({
      status: 'parsed',
      toolName: 'insert_vocabulary',
      arguments: { term: 'apple' }
    })
  })
  it('keeps non-object JSON argument values as-is for domain validation', () => {
    const response = completion({ toolCalls: [toolCall('insert_vocabulary', '7')] })
    expect(parseSingleToolCallResponse(response)).toEqual({
      status: 'parsed',
      toolName: 'insert_vocabulary',
      arguments: 7
    })
  })
  it.each([
    ['null content', completion({ content: null, toolCalls: [toolCall('x', '{}')] })],
    ['empty content', completion({ content: '', toolCalls: [toolCall('x', '{}')] })],
    ['missing content', singleCall],
    ['null refusal', completion({ refusal: null, toolCalls: [toolCall('x', '{}')] })],
    ['missing refusal', singleCall]
  ])('accepts empty or absent text fields: %s', (_name, response) => {
    expect(parseSingleToolCallResponse(response).status).toBe('parsed')
  })
  it.each([
    ['choices is not an array', { choices: 'busy' }],
    ['message is not an object', { choices: [{ finish_reason: 'tool_calls', message: 'busy' }] }],
    ['finish_reason is not a string', { choices: [{ finish_reason: 7, message: {} }] }],
    [
      'tool call type is not function',
      completion({ toolCalls: [{ type: 'custom', function: { name: 'x', arguments: '{}' } }] })
    ],
    [
      'function payload is not an object',
      completion({ toolCalls: [{ type: 'function', function: 'busy' }] })
    ]
  ])('reports malformed responses with the schema cause: %s', (_name, response) => {
    const result = parseSingleToolCallResponse(response)
    expect(result.status).toBe('malformed-response')
    if (result.status !== 'malformed-response') throw new Error('unreachable')
    expect(result.cause).toBeInstanceOf(Error)
  })
  it.each([
    ['missing choices key', {}],
    ['empty choices', { choices: [] }],
    ['plain stop finish', completion({ finishReason: 'stop', toolCalls: [toolCall('x', '{}')] })],
    ['truncated finish', completion({ finishReason: 'length', toolCalls: [toolCall('x', '{}')] })],
    ['null finish', completion({ finishReason: null, toolCalls: [toolCall('x', '{}')] })],
    ['refusal', completion({ refusal: 'not allowed', toolCalls: [toolCall('x', '{}')] })],
    ['non-empty content', completion({ content: 'extra text', toolCalls: [toolCall('x', '{}')] })],
    ['whitespace-only content', completion({ content: '  ', toolCalls: [toolCall('x', '{}')] })],
    ['zero tool calls', completion({ toolCalls: [] })],
    ['multiple tool calls', completion({ toolCalls: [toolCall('a', '{}'), toolCall('b', '{}')] })]
  ])('rejects single-tool-call violations without a cause: %s', (_name, response) => {
    expect(parseSingleToolCallResponse(response)).toEqual({ status: 'invalid-tool-call' })
  })
  it('rejects corrupted JSON arguments with the parse error as cause', () => {
    const result = parseSingleToolCallResponse(
      completion({ toolCalls: [toolCall('insert_vocabulary', '{not json')] })
    )
    expect(result.status).toBe('invalid-tool-call')
    if (result.status !== 'invalid-tool-call') throw new Error('unreachable')
    expect(result.cause).toBeInstanceOf(SyntaxError)
  })
  it('allows provider extension fields on choices and messages', () => {
    const response = {
      id: 'chatcmpl-1',
      model: 'fixture',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            annotations: [],
            content: null,
            refusal: null,
            tool_calls: [toolCall('insert_vocabulary', '{}')]
          }
        }
      ]
    }
    expect(parseSingleToolCallResponse(response).status).toBe('parsed')
  })
})

describe('isUnsupportedToolCall', () => {
  it.each([
    { status: 400, message: 'tools is not supported for this model' },
    { status: 400, message: 'tool_choice is unsupported' },
    { status: 400, message: 'Invalid parameter: tools' }
  ])('recognizes tool capability errors %#', (error) => {
    expect(isUnsupportedToolCall(error)).toBe(true)
  })
  it.each([
    { status: 401, message: 'tools unsupported' },
    { status: 429, message: 'tool_choice unavailable' },
    { status: 500, message: 'tools unavailable' },
    { status: 400, message: 'Invalid model id' },
    new Error('tools are not supported'),
    'tools are not supported',
    null
  ])('keeps other failures outside the capability category %#', (error) => {
    expect(isUnsupportedToolCall(error)).toBe(false)
  })
})
