/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript executable. */
// Runtime-only smoke: no BrowserWindow, renderer, application bootstrap or database.
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const modelPath = option('--resources')
if (!modelPath) throw new Error('Required: --resources <isolated installed model directory>')
const runtime = resolve(option('--runtime') ?? 'out/main/headtts-entry.js')
const reportPath = option('--report')
const manifest = JSON.parse(
  await readFile(new URL('../resources/speech/headtts/manifest.json', import.meta.url), 'utf8')
)
for (const file of manifest.files) {
  const bytes = await readFile(join(resolve(modelPath), file.path))
  if (
    bytes.byteLength !== file.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new Error(`Resource identity failed: ${file.path}`)
}
const scratch = await mkdtemp(join(tmpdir(), 'lingo-speech-smoke-'))
const report = join(scratch, 'report.json')
const corpus = JSON.parse(
  await readFile(
    new URL('../src/main/speech/__tests__/fixtures/speech-corpus.json', import.meta.url),
    'utf8'
  )
)
const samples = corpus.map((text, index) => ({
  text,
  speed: [0.75, 1, 1.5][index % 3],
  voice: index % 2 ? 'am_michael' : 'af_bella'
}))
const samplesPath = join(scratch, 'samples.json')
await writeFile(samplesPath, JSON.stringify(samples))
const artifactPath = option('--artifacts')
if (artifactPath) await mkdir(resolve(artifactPath), { recursive: true })
const harnessPath = fileURLToPath(new URL('./speech-runtime-harness.cjs', import.meta.url))
const electron = option('--electron') ?? createRequire(import.meta.url)('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const exitCode = await new Promise((done, reject) => {
  const child = spawn(
    electron,
    [
      harnessPath,
      resolve(modelPath),
      runtime,
      scratch,
      samplesPath,
      report,
      artifactPath ? resolve(artifactPath) : ''
    ],
    { env, stdio: 'pipe' }
  )
  const timer = setTimeout(() => child.kill(), 190_000)
  let diagnostic = ''
  child.stdout.on('data', (bytes) => {
    diagnostic += String(bytes).slice(0, 4000)
  })
  child.stderr.on('data', (bytes) => {
    diagnostic += String(bytes).slice(0, 4000)
  })
  child.on('error', reject)
  child.on('exit', (code) => {
    clearTimeout(timer)
    if (code) console.error(diagnostic.slice(0, 4000))
    done(code ?? 1)
  })
})
try {
  const result = await readFile(report, 'utf8')
  if (reportPath) await writeFile(resolve(reportPath), result)
  const parsed = JSON.parse(result)
  if (artifactPath && parsed.status === 'ok') {
    const annotations = parsed.results.map((sample, index) => {
      let offset = 0
      return {
        id: index,
        audio: `sample-${index}.wav`,
        text: sample.text,
        voice: sample.voice,
        speed: sample.speed,
        words: sample.words.map((text, wordIndex) => {
          const charStart = offset
          offset += text.length
          return {
            index: wordIndex,
            text,
            charStart,
            charEnd: offset,
            predictedStart: sample.wtimes[wordIndex] / 1000,
            predictedEnd: (sample.wtimes[wordIndex] + sample.wdurations[wordIndex]) / 1000,
            referenceStart: null,
            referenceEnd: null
          }
        })
      }
    })
    await writeFile(
      join(resolve(artifactPath), 'alignment-references.json'),
      JSON.stringify({ status: 'awaiting-human-annotation', samples: annotations }, null, 2)
    )
  }
  console.log(
    JSON.stringify({
      status: parsed.status,
      platform: parsed.platform,
      arch: parsed.arch,
      electron: parsed.electron,
      coldMs: parsed.coldMs,
      peakKb: parsed.peakKb,
      samples: parsed.results.length,
      words: parsed.results.reduce((sum, value) => sum + value.words.length, 0),
      diagnostic: parsed.diagnostic
    })
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
process.exitCode = exitCode
