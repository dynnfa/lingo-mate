import { describe, expect, it } from 'vitest'
import { toolRequestParams, type ToolRequestPolicyConnection } from '../tool-request-policy'

const connection = (
  overrides: Partial<ToolRequestPolicyConnection>
): ToolRequestPolicyConnection => ({
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'fixture',
  ...overrides
})

const deepSeekConnection = (
  overrides: Partial<ToolRequestPolicyConnection> = {}
): ToolRequestPolicyConnection =>
  connection({
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-v4-chat',
    ...overrides
  })

describe('toolRequestParams', () => {
  describe('single-tool-result intent', () => {
    it('enables thinking parameters for the DeepSeek host with a v4-prefixed model', () => {
      expect(toolRequestParams('single-tool-result', deepSeekConnection())).toEqual({
        tool_choice: 'auto',
        thinking: { type: 'enabled' },
        reasoning_effort: 'high'
      })
    })
    it.each([
      ['non-v4 model on the DeepSeek host', { modelId: 'deepseek-chat' }],
      ['v4-prefixed model on another host', { baseUrl: 'https://api.example.com/v1' }],
      ['subdomain lookalike host', { baseUrl: 'https://api.deepseek.com.evil.example/v1' }]
    ])('keeps plain auto tool choice: %s', (_name, overrides) => {
      expect(toolRequestParams('single-tool-result', deepSeekConnection(overrides))).toEqual({
        tool_choice: 'auto'
      })
    })
    it('never sets parallel_tool_calls on single requests', () => {
      const params = toolRequestParams('single-tool-result', deepSeekConnection())
      expect('parallel_tool_calls' in params).toBe(false)
      expect('parallel_tool_calls' in toolRequestParams('single-tool-result', connection({}))).toBe(
        false
      )
    })
    it('does not throw on an unparseable base URL', () => {
      expect(toolRequestParams('single-tool-result', connection({ baseUrl: 'not a url' }))).toEqual(
        {
          tool_choice: 'auto'
        }
      )
    })
  })

  describe('multi-turn-tool-loop intent', () => {
    it('disables parallel tool calls on OpenAI-compatible protocols', () => {
      expect(toolRequestParams('multi-turn-tool-loop', connection({}))).toEqual({
        tool_choice: 'auto',
        parallel_tool_calls: false
      })
    })
    it('omits parallel_tool_calls on the Gemini protocol', () => {
      const params = toolRequestParams('multi-turn-tool-loop', connection({ protocol: 'gemini' }))
      expect(params).toEqual({ tool_choice: 'auto' })
      expect('parallel_tool_calls' in params).toBe(false)
    })
    it('does not spread DeepSeek thinking parameters into multi-turn requests', () => {
      const params = toolRequestParams('multi-turn-tool-loop', deepSeekConnection())
      expect(params).toEqual({ tool_choice: 'auto', parallel_tool_calls: false })
      expect('thinking' in params).toBe(false)
      expect('reasoning_effort' in params).toBe(false)
    })
  })
})
