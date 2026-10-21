import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { agentFrameSchema } from '../src/core/agent/agent-protocol.ts'
const path = new URL('../agent-engine/src/lingo_agent/protocol/schema.json', import.meta.url)
const schema = JSON.stringify(z.toJSONSchema(agentFrameSchema), null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== schema) throw new Error('Agent protocol schema is stale')
} else writeFileSync(path, schema)
