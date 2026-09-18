import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAiImportFailureLogger } from '../ai-import-failure-log'

it('writes failure details and response to disk while redacting credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-import-log-'))
  try {
    const log = createAiImportFailureLogger(directory)
    log(
      {
        term: 'protest',
        modelId: 'fixture',
        promptVersion: 'v3',
        code: 'INVALID_ANALYSIS',
        stage: 'protocol',
        issues: [],
        response: {
          choices: [{ message: { content: 'returned text secret-key' } }],
          headers: { Authorization: 'Bearer secret-key' }
        }
      },
      'secret-key'
    )
    const text = readFileSync(join(directory, 'ai-import-errors.log'), 'utf8')
    const entry = JSON.parse(text)
    expect(entry.term).toBe('protest')
    expect(entry.response.choices[0].message.content).toBe('returned text [REDACTED]')
    expect(entry.timestamp).toEqual(expect.any(String))
    expect(text).not.toContain('secret-key')
    expect(entry.response.headers).toBe('[REDACTED]')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
