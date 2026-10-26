import { SPEECH_IDENTITY } from '../../../shared/speech'
import { SpeechError } from '../../../core/speech/speech-synthesizer'
import { runtimeRequestSchema } from '../headtts-protocol'
import { HeadTtsAdapter } from './headtts-adapter'

const port = process.parentPort
if (!port) throw new Error('Missing utility process port')
const adapter = new HeadTtsAdapter()
let initialized = false
let busy = false
port.on('message', async (event) => {
  try {
    const message = runtimeRequestSchema.parse(event.data)
    if (message.type === 'init' && !initialized) {
      initialized = true
      await adapter.connect(message.modelPath)
      port.postMessage({ type: 'ready', identity: SPEECH_IDENTITY })
    } else if (message.type === 'synthesize' && initialized && !busy) {
      busy = true
      try {
        const segment = await adapter.synthesize(message.id, message.text, message.settings)
        port.postMessage({ type: 'audio', id: message.id, segment })
      } catch (error) {
        if (error instanceof SpeechError && error.code === 'TOKEN_LIMIT')
          port.postMessage({ type: 'token-limit', id: message.id })
        else throw error
      } finally {
        busy = false
      }
    } else throw new Error('Invalid runtime state')
  } catch (error) {
    console.error(error)
    port.postMessage({ type: 'error' })
  }
})
