/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript executable. */
import { readFile } from 'node:fs/promises'

const file = process.argv[2]
if (!file)
  throw new Error(
    'Required: speech-alignment-check.mjs <human-annotated alignment-references.json>'
  )
const references = JSON.parse(await readFile(file, 'utf8'))
const startErrors = []
const endErrors = []
const samples = references.samples
if (!Array.isArray(samples) || samples.length < 30)
  throw new Error('At least 30 independently reviewed samples are required')
for (const sample of samples) {
  for (const word of sample.words) {
    if (
      ![word.referenceStart, word.referenceEnd, word.predictedStart, word.predictedEnd].every(
        (value) => typeof value === 'number' && Number.isFinite(value)
      ) ||
      word.referenceStart < 0 ||
      word.referenceEnd <= word.referenceStart
    )
      throw new Error(`Missing or invalid human reference: sample ${sample.id}, word ${word.index}`)
    startErrors.push(Math.abs(word.predictedStart - word.referenceStart))
    endErrors.push(Math.abs(word.predictedEnd - word.referenceEnd))
  }
}
if (
  startErrors.length < 200 ||
  ![0.75, 1, 1.5].every((speed) => samples.some((sample) => sample.speed === speed))
)
  throw new Error('At least 200 boundaries and all three synthesis speeds are required')
const percentile = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
const report = {
  boundaries: startErrors.length,
  startP95Ms: percentile(startErrors) * 1000,
  startMaxMs: Math.max(...startErrors) * 1000,
  endP95Ms: percentile(endErrors) * 1000,
  endMaxMs: Math.max(...endErrors) * 1000
}
console.log(JSON.stringify(report, null, 2))
if (report.startP95Ms > 100 || report.startMaxMs > 200) process.exitCode = 1
