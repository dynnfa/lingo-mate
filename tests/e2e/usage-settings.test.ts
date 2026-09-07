import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

// 真实 Electron 下的 Usage 入口与桥接读取流程：
// 空账本显示空状态与时间轴，preload 暴露的窄接口返回一致快照。
test('opens Settings > Usage with an empty ledger and reads the overview through the bridge', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const electronApp = await launchApp(userDataPath)
    try {
      const window = await electronApp.firstWindow()
      await waitForReady(window)

      await window.click('.settings-button')
      await expect(window.locator('main.settings-page')).toBeVisible()
      await window.getByRole('button', { name: '用量' }).click()

      // 空账本：空状态 + 范围时间轴，不渲染图表
      await expect(window.getByText('尚无用量记录')).toBeVisible({ timeout: 10_000 })
      await expect(window.getByText(/时间轴范围：/)).toBeVisible()

      // 摘要卡仍显示（全部为零），刷新按钮可用
      await expect(window.getByText('今日')).toBeVisible()
      await expect(window.getByText('本周')).toBeVisible()
      await expect(window.getByRole('button', { name: '刷新' })).toBeEnabled()

      // 桥接读取：协议形状与一致性快照
      const overview = await window.evaluate(async () => {
        const usage = (
          globalThis as typeof globalThis & {
            api: { usage: { getOverview(input: unknown): Promise<unknown> } }
          }
        ).api.usage
        return usage.getOverview({})
      })
      const result = overview as {
        status: string
        overview: {
          asOf: string
          timeZone: string
          days: unknown[]
          weeks: unknown[]
          dailyByWeek: Record<string, unknown[]>
          today: { requestCount: number }
        }
      }
      expect(result.status).toBe('ok')
      expect(result.overview.timeZone.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(result.overview.asOf))).toBe(false)
      expect(result.overview.days).toHaveLength(30)
      expect(result.overview.weeks).toHaveLength(8)
      expect(Object.keys(result.overview.dailyByWeek)).toHaveLength(8)
      for (const days of Object.values(result.overview.dailyByWeek)) {
        expect(days).toHaveLength(7)
      }
      expect(result.overview.today.requestCount).toBe(0)

      // 维度切换与刷新在真实窗口内可用；空账本下切维度仍显示空状态
      await window.getByRole('button', { name: '按周' }).click()
      await expect(window.getByRole('button', { name: '按周' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(window.getByText('尚无用量记录')).toBeVisible()
      await window.getByRole('button', { name: '刷新' }).click()
      await expect(window.getByText(/更新于/)).toBeVisible({ timeout: 10_000 })
    } finally {
      await electronApp.close()
    }
  })
})
