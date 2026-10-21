import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_PROTOCOL_VERSION } from '../../core/agent/agent-protocol'
import type { PythonAgentLaunch } from './python-agent-process'

export function resolvePythonAgentLaunch(options: {
  packaged: boolean
  appPath: string
  resourcesPath: string
  appVersion: string
  bundledDevelopment?: boolean
}): Pick<PythonAgentLaunch, 'command' | 'args'> {
  if (!options.packaged && !options.bundledDevelopment) {
    return {
      command: join(
        options.appPath,
        'agent-engine',
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', '-m', 'lingo_agent']
    }
  }
  const directory = options.packaged
    ? join(options.resourcesPath, 'agent-engine')
    : join(
        options.appPath,
        'agent-engine',
        'dist',
        `${process.platform}-${process.arch}`,
        'lingo-agent'
      )
  z.strictObject({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    appVersion: z.literal(options.appVersion),
    platform: z.literal(process.platform),
    arch: z.literal(process.arch)
  }).parse(JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')))
  return {
    command: join(directory, process.platform === 'win32' ? 'lingo-agent.exe' : 'lingo-agent'),
    args: []
  }
}
