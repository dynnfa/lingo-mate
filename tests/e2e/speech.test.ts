import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../../src/database/migrations'
import { SPEECH_IDENTITY } from '../../src/shared/speech'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

// Resource-intensive opt-in: execute only with human E2E permission and explicitly
// preinstalled test resources. Missing resources is an error in the explicit run.
test('plays, pauses, seeks, replaces a source and clears highlighting on stop', async () => {
  const resources = process.env.LINGO_MATE_SPEECH_E2E_RESOURCES
  if (!resources)
    throw new Error('Explicit speech E2E resource preparation required; see docs/speech-runtime.md')
  test.setTimeout(180_000)
  await withTempUserData(async (directory) => {
    const models = join(directory, 'speech', 'models')
    await mkdir(models, { recursive: true })
    await cp(resources!, join(models, SPEECH_IDENTITY.revision), { recursive: true })
    await writeLocalePreference(directory, 'en')
    const database = new Database(join(directory, 'lingo-mate.sqlite'))
    try {
      migrateDatabase(database)
      database
        .prepare(
          `INSERT INTO vocabulary (id, term, meaning, example_sentences, model_id, prompt_version, created_at)
        VALUES (?, ?, ?, ?, 'fixture-model', 'vocabulary-tools-v2', ?)`
        )
        .run(
          'e5000000-0000-4000-8000-000000000001',
          'hello',
          'A greeting.',
          JSON.stringify([
            'Hello, hello! This is a longer example for testing audio playback and word highlighting.'
          ]),
          '2026-10-23T00:00:00.000Z'
        )
    } finally {
      database.close()
    }
    const app = await launchApp(directory)
    try {
      const window = await app.firstWindow()
      await waitForReady(window)
      await window.getByRole('button', { name: 'Recorded vocabulary', exact: true }).click()
      await window
        .getByRole('button', {
          name: 'Read aloud: Hello, hello! This is a longer example for testing audio playback and word highlighting.'
        })
        .click()
      const player = window.getByRole('region', { name: 'Speech playback' })
      await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({
        timeout: 120_000
      })
      await expect(window.locator('mark.speech-word')).toBeVisible()
      await player.getByRole('button', { name: 'Pause', exact: true }).click()
      const position = await player.getByRole('slider').inputValue()
      await window.waitForTimeout(150)
      expect(await player.getByRole('slider').inputValue()).toBe(position)
      await player.getByRole('slider').focus()
      await player.getByRole('slider').press('Home')
      await player.getByRole('slider').press('ArrowRight')
      await player.getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
      await window.getByRole('button', { name: 'Read aloud: hello', exact: true }).click()
      await expect(
        window.getByRole('button', { name: 'Stop reading: hello', exact: true })
      ).toBeVisible()
      await player.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect(window.locator('mark.speech-word')).toHaveCount(0)
    } finally {
      await app.close()
    }
  }, 'lingo-speech-e2e-')
})
