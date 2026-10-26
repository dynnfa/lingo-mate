import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SPEECH_LIMITS } from '../../../shared/speech'
import { speechManifest } from '../speech-assets'
import { decoderFrameDurations } from './headtts-corrections'
import type { Tensor } from '@huggingface/transformers'

interface LanguageRuntime {
  loadDictionary(path: string): Promise<void>
  generate(text: string): { phonemes: string[]; metadata: { words: string[] } }
}

async function start(): Promise<void> {
  const port = parentPort as
    | (NonNullable<typeof parentPort> & {
        onmessage:
          | ((event: {
              data: { type: string; id: string; data: { input: string } }
            }) => Promise<void>)
          | null
      })
    | null
  if (!port) throw new Error('Missing worker port')
  const data = workerData as { modelPath: string; headttsRoot: string }
  // Use the SAME ESM module instance as the upstream Worker, before it is imported.
  const { env, AutoTokenizer, StyleTextToSpeech2Model } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useFSCache = false
  env.useBrowserCache = false
  const loadModel = StyleTextToSpeech2Model.from_pretrained.bind(StyleTextToSpeech2Model)
  StyleTextToSpeech2Model.from_pretrained = async (...args) => {
    const model = await loadModel(...args)
    const infer = model._call.bind(model)
    model._call = async (input: unknown): Promise<Record<string, Tensor>> => {
      const output = (await infer(input)) as Record<string, Tensor>
      const raw = output.durations?.data
      const waveform = output.waveform?.data
      if (!(raw instanceof Float32Array) || !(waveform instanceof Float32Array))
        throw new Error('Invalid model outputs')
      raw.set(decoderFrameDurations(raw, waveform.length))
      return output
    }
    return model
  }
  const dictionaryPath = join(data.headttsRoot, 'dictionaries', 'en-us.txt')
  const dictionary = await readFile(dictionaryPath)
  if (createHash('sha256').update(dictionary).digest('hex') !== speechManifest.dictionary.sha256)
    throw new Error('Dictionary identity mismatch')
  const { Language } = (await import(
    pathToFileURL(join(data.headttsRoot, 'modules', 'language-en-us.mjs')).href
  )) as { Language: new () => LanguageRuntime }
  const language = new Language()
  await language.loadDictionary(dictionaryPath)
  const tokenizer = await AutoTokenizer.from_pretrained(data.modelPath, { local_files_only: true })
  await import(pathToFileURL(join(data.headttsRoot, 'modules', 'worker-tts.mjs')).href)
  const upstream = port.onmessage
  if (!upstream) throw new Error('HeadTTS contract mismatch')
  port.onmessage = async (event) => {
    const message = event.data
    if (message.type === 'synthesize') {
      // Preflight the exact upstream phonemes/tokenizer. Never let its truncation run.
      const generated = language.generate(message.data.input)
      const { input_ids } = tokenizer(generated.phonemes.join(''), { truncation: false })
      if (input_ids.size > SPEECH_LIMITS.tokens) {
        port.postMessage({ type: 'token-limit', ref: message.id })
        return
      }
      if (generated.metadata.words.join('') !== message.data.input)
        throw new Error('Unmappable text')
    }
    await upstream.call(port, event)
  }
  port.postMessage({ type: 'booted' })
}
void start().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
  parentPort?.close()
})
