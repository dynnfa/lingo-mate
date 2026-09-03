import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('exposes the conversation interface from the sandboxed preload', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'lingo-mate-electron-smoke-'))
  const electronApp = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${userDataPath}`]
  })

  try {
    const window = await electronApp.firstWindow()

    await expect
      .poll(() =>
        window.evaluate(
          () =>
            typeof (
              globalThis as typeof globalThis & {
                api?: { conversation?: { send?: unknown } }
              }
            ).api?.conversation?.send
        )
      )
      .toBe('function')
  } finally {
    await electronApp.close()
    await rm(userDataPath, { force: true, recursive: true })
  }
})
