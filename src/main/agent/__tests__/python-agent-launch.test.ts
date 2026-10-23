import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePythonAgentLaunch } from '../python-agent-launch'
import { agentEnvironment } from '../python-agent-process'

describe('agent executable boundary', () => {
  it('uses only the bundled executable and refuses a mismatched runtime manifest', () => {
    const resources = mkdtempSync(join(tmpdir(), 'lingo-agent-'))
    const directory = join(resources, 'agent-engine')
    mkdirSync(directory)
    const manifest = {
      protocolVersion: 10,
      appVersion: '1.0.0',
      platform: process.platform,
      arch: process.arch
    }
    const options = {
      packaged: true,
      appPath: '/ignored',
      resourcesPath: resources,
      appVersion: '1.0.0'
    }
    try {
      writeFileSync(join(directory, 'runtime.json'), JSON.stringify(manifest))
      expect(resolvePythonAgentLaunch(options)).toEqual({
        command: join(directory, process.platform === 'win32' ? 'lingo-agent.exe' : 'lingo-agent'),
        args: []
      })
      writeFileSync(
        join(directory, 'runtime.json'),
        JSON.stringify({ ...manifest, protocolVersion: 99 })
      )
      expect(() => resolvePythonAgentLaunch(options)).toThrow()
      expect(agentEnvironment()).not.toHaveProperty('OPENAI_API_KEY')
      expect(agentEnvironment()).not.toHaveProperty('PATH')
      expect(agentEnvironment()).not.toHaveProperty('LANGSMITH_API_KEY')
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })
})
