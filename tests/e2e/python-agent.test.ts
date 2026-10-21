import { execFileSync } from 'node:child_process'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

function childPid(parent: number): number | undefined {
  if (process.platform === 'win32') return undefined
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split(
    '\n'
  )
  const row = rows.find((r) => {
    const [, ppid, ...command] = r.trim().split(/\s+/)
    return Number(ppid) === parent && /lingo_agent|lingo-agent/.test(command.join(' '))
  })
  return row ? Number(row.trim().split(/\s+/)[0]) : undefined
}

for (const target of ['development', 'bundled', 'packaged']) {
  test(`Python pilot ${target}: stream, concept, cancel, crash, retry and exit`, async () => {
    test.setTimeout(90_000)
    test.skip(
      target === 'packaged' && process.env['LINGO_MATE_TEST_PACKAGED'] !== '1',
      'Requires an explicit native electron-builder --dir build'
    )
    await withTempUserData(async (userData) => {
      await writeLocalePreference(userData, 'zh-CN')
      const app = await launchApp(userData, {
        agentRuntime: 'python',
        agentBundle: target === 'bundled',
        packaged: target === 'packaged'
      })
      let pid: number | undefined
      try {
        const window = await app.firstWindow()
        await waitForReady(window)
        await window.fill('#message', '/concept carry')
        await window.press('#message', 'Enter')
        await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 40_000 })
        await expect(window.locator('.message')).toHaveCount(2)
        await expect(window.locator('.message.assistant')).toContainText('/concept carry')
        pid = childPid(app.process().pid!)
        if (process.platform !== 'win32') expect(pid).toBeGreaterThan(0)

        await window.fill('#message', 'Hello')
        await window.press('#message', 'Enter')
        await expect(window.locator('.thinking-preview')).toBeVisible()
        await window.getByRole('button', { name: '取消', exact: true }).click()
        await expect(window.locator('.status')).toHaveText('已取消，可重试。')
        await expect(window.locator('.message.assistant')).toHaveCount(1)
        await window.getByRole('button', { name: '重试', exact: true }).click()
        await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 40_000 })
        await expect(window.locator('.message')).toHaveCount(4)

        if (pid) {
          await window.fill('#message', 'crash test')
          await window.press('#message', 'Enter')
          await expect(window.locator('.thinking-preview')).toBeVisible()
          process.kill(pid, 'SIGKILL')
          await expect(window.locator('.status')).toHaveText('Agent 引擎暂不可用，请重试。')
          await window.getByRole('button', { name: '重试', exact: true }).click()
          await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 40_000 })
          const nextPid = childPid(app.process().pid!)
          expect(nextPid).not.toBe(pid)
          pid = nextPid
        }
        await window.fill('#message', 'exit while generating')
        await window.press('#message', 'Enter')
        await expect(window.locator('.thinking-preview')).toBeVisible()
      } finally {
        await app.close()
      }
      if (pid) expect(() => process.kill(pid!, 0)).toThrow()
    })
  })
}
