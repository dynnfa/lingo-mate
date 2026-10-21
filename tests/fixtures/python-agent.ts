import { resolve } from 'node:path'
import { afterEach } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'

const runtimes: PythonAgentRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
})

export function createTestBatchRuntime(): PythonAgentRuntime {
  const runtime = new PythonAgentRuntime(
    new PythonAgentProcess({
      command: resolve(
        'agent-engine/.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', '-m', 'lingo_agent']
    }),
    () => {
      throw new Error('Batch analysis must not use the conversation model')
    }
  )
  runtimes.push(runtime)
  return runtime
}

export const createTestVocabularyRuntime = createTestBatchRuntime
export const createTestPhraseRuntime = createTestBatchRuntime
