import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { readSpeechWav } from '../../src/core/speech/speech-audio'
import { buildSpeechTimeline } from '../../src/core/speech/speech-timeline'
import { SPEECH_IDENTITY } from '../../src/shared/speech'

it('loads the pinned FP32 runtime offline and validates the entire English regression corpus', async () => {
  const resources = process.env.LINGO_MATE_SPEECH_TEST_RESOURCES
  if (!resources)
    throw new Error(
      'Set LINGO_MATE_SPEECH_TEST_RESOURCES to explicitly prepared, isolated FP32 test resources; see docs/speech-runtime.md'
    )
  const scratch = await mkdtemp(join(tmpdir(), 'lingo-speech-integration-'))
  try {
    const reportPath = join(scratch, 'report.json')
    await promisify(execFile)(
      process.execPath,
      [
        'scripts/speech-runtime-smoke.mjs',
        '--resources',
        resources,
        '--report',
        reportPath,
        '--artifacts',
        scratch
      ],
      { timeout: 185_000 }
    )
    const report = z
      .object({
        status: z.literal('ok'),
        identity: z.object({
          dtype: z.literal('fp32'),
          revision: z.literal(SPEECH_IDENTITY.revision)
        }),
        results: z.array(
          z.object({
            text: z.string(),
            words: z.array(z.string()),
            wtimes: z.array(z.number()),
            wdurations: z.array(z.number()),
            speed: z.number(),
            voice: z.string()
          })
        )
      })
      .parse(JSON.parse(await readFile(reportPath, 'utf8')))
    expect(report.results).toHaveLength(30)
    let words = 0
    for (const [index, segment] of report.results.entries()) {
      const wav = readSpeechWav(await readFile(join(scratch, `sample-${index}.wav`)))
      const timeline = buildSpeechTimeline(segment.text, segment, wav.seconds)
      words += timeline.length
      for (const word of timeline)
        expect(segment.text.slice(word.charStart, word.charEnd)).toBe(word.text)
    }
    expect(words).toBeGreaterThanOrEqual(200)
    expect(new Set(report.results.map((sample) => sample.speed))).toEqual(new Set([0.75, 1, 1.5]))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
