import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  launchApp,
  startFakeModelServer,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

async function openModelsSection(
  window: Awaited<ReturnType<ReturnType<typeof launchApp>['firstWindow']>>
): Promise<void> {
  await window.click('.settings-button')
  await expect(window.locator('main.settings-page')).toBeVisible()
  await window.getByRole('button', { name: '模型' }).click()
  await expect(window.getByRole('heading', { name: '模型', exact: true })).toBeVisible()
}

test('manages multiple saved models from the Settings > Models table end to end', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const serverA = await startFakeModelServer()
    const serverB = await startFakeModelServer()
    try {
      // 远程模式启动：尚未配置模型
      const firstLaunch = await launchApp(userDataPath, { model: 'remote' })
      const window = await firstLaunch.firstWindow()
      await waitForReady(window)

      await window.fill('#message', '你好')
      await window.press('#message', 'Enter')
      await expect(window.locator('.status')).toContainText('尚未配置模型', { timeout: 15_000 })

      // 进入设置 → 模型：空状态展示新增入口
      await openModelsSection(window)
      await expect(window.getByText('还没有已配置的模型')).toBeVisible()

      // 新增第一条配置（带密钥）：保存后进入表格并自动成为当前模型
      await window.getByRole('button', { name: '新增模型' }).click()
      await expect(window.getByRole('heading', { name: '新增模型' })).toBeVisible()
      await window.fill('#models-base-url', `${serverA.baseUrl}/v1`)
      await window.fill('#models-model-id', 'model-a')
      await window.fill('#models-api-key', 'sk-e2e-a1b2c3d4')
      await window.getByRole('button', { name: '保存' }).click()

      const rowA = window.getByRole('row', { name: /model-a/ })
      await expect(rowA).toBeVisible()
      // 密钥只显示脱敏预览：前 4 位与后 4 位，中间整段掩码
      await expect(rowA.getByText('sk-e••••c3d4')).toBeVisible()
      await expect(window.locator('#models-active-config')).toContainText('model-a')

      // 新增第二条配置（无密钥）：不改变当前模型
      await window.getByRole('button', { name: '新增模型' }).click()
      await window.fill('#models-base-url', `${serverB.baseUrl}/v1`)
      await window.fill('#models-model-id', 'model-b')
      await window.getByRole('button', { name: '保存' }).click()

      const rowB = window.getByRole('row', { name: /model-b/ })
      await expect(rowB).toBeVisible()
      await expect(rowB.getByText('未配置')).toBeVisible()
      await expect(window.locator('#models-active-config')).toContainText('model-a')

      // 测试指定行：结果只属于该行
      await rowB.getByRole('button', { name: '测试连通' }).click()
      await expect(rowB.getByText('成功')).toBeVisible({ timeout: 15_000 })
      await expect(rowA.getByText('未测试')).toBeVisible()

      // 编辑第一条：不回填密钥，保存后行更新且当前选择保持
      await rowA.getByRole('button', { name: '编辑' }).click()
      await expect(window.getByRole('heading', { name: '编辑模型' })).toBeVisible()
      await expect(window.locator('#models-base-url')).toHaveValue(`${serverA.baseUrl}/v1`)
      await expect(window.locator('#models-api-key')).toHaveValue('')
      await window.fill('#models-model-id', 'model-a-2')
      await window.getByRole('button', { name: '保存' }).click()

      await expect(window.getByRole('row', { name: /model-a-2/ })).toBeVisible()
      await expect(window.getByRole('row', { name: /model-a / })).toBeHidden()
      await expect(window.locator('#models-active-config')).toContainText('model-a-2')

      // 删除非当前模型：确认后仅该行消失
      await rowB.getByRole('button', { name: '删除' }).click()
      const deleteDialog = window.locator('.settings-confirm')
      await expect(deleteDialog).toContainText('model-b')
      await deleteDialog.getByRole('button', { name: '删除' }).click()
      await expect(window.getByRole('row', { name: /model-b/ })).toBeHidden()

      // 删除当前模型：确认文案提示重新选择，删除后回到空状态
      const rowA2 = window.getByRole('row', { name: /model-a-2/ })
      await rowA2.getByRole('button', { name: '删除' }).click()
      await expect(deleteDialog).toContainText('删除后需要重新选择模型')
      await deleteDialog.getByRole('button', { name: '删除' }).click()
      await expect(window.getByText('还没有已配置的模型')).toBeVisible()

      // 重新配置一条并用于真实对话
      await window.getByRole('button', { name: '新增模型' }).click()
      await window.fill('#models-base-url', `${serverA.baseUrl}/v1`)
      await window.fill('#models-model-id', 'model-final')
      await window.getByRole('button', { name: '保存' }).click()
      await expect(window.getByRole('row', { name: /model-final/ })).toBeVisible()

      await window.click('.settings-back-button')
      await expect(window.locator('main.settings-page')).toBeHidden()

      await window.fill('#message', '开始练习')
      await window.press('#message', 'Enter')
      await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
      await expect(window.locator('.message.assistant').last()).toContainText('这是假模型')

      await firstLaunch.close()

      // 重启后配置集合与当前模型选择仍然生效，密钥永不回填
      const secondLaunch = await launchApp(userDataPath, { model: 'remote' })
      const secondWindow = await secondLaunch.firstWindow()
      await waitForReady(secondWindow)
      await openModelsSection(secondWindow)
      await expect(secondWindow.getByRole('row', { name: /model-final/ })).toBeVisible()
      await expect(secondWindow.locator('#models-active-config')).toContainText('model-final')
      await secondWindow
        .getByRole('row', { name: /model-final/ })
        .getByRole('button', { name: '编辑' })
        .click()
      await expect(secondWindow.locator('#models-api-key')).toHaveValue('')

      await secondLaunch.close()
    } finally {
      await serverA.close()
      await serverB.close()
    }
  })
})

test('upgrades a v1 single-config record so the existing model keeps working', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const server = await startFakeModelServer()
    try {
      // 旧用户的版本 1 单配置文件
      await writeFile(
        join(userDataPath, 'models.json'),
        JSON.stringify({
          schemaVersion: 1,
          protocol: 'openai-compatible',
          baseUrl: `${server.baseUrl}/v1`,
          modelId: 'legacy-model'
        })
      )

      const app = await launchApp(userDataPath, { model: 'remote' })
      const window = await app.firstWindow()
      await waitForReady(window)

      // 原模型继续生效：无需重新输入
      await window.fill('#message', '你好')
      await window.press('#message', 'Enter')
      await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })

      // 设置页展示迁移后的单条记录，且已选为当前模型
      await openModelsSection(window)
      const row = window.getByRole('row', { name: /legacy-model/ })
      await expect(row).toBeVisible()
      await expect(window.locator('#models-active-config')).toContainText('legacy-model')

      await app.close()
    } finally {
      await server.close()
    }
  })
})

test('keeps the action column reachable at 900×670 and narrow breakpoints', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const server = await startFakeModelServer()
    try {
      const app = await launchApp(userDataPath, { model: 'remote' })
      const window = await app.firstWindow()
      await waitForReady(window)
      await openModelsSection(window)

      await window.getByRole('button', { name: '新增模型' }).click()
      await window.fill('#models-base-url', `${server.baseUrl}/v1`)
      await window.fill('#models-model-id', 'long-model-identifier-for-narrow-viewports')
      await window.getByRole('button', { name: '保存' }).click()
      await expect(window.getByRole('row', { name: /long-model-identifier/ })).toBeVisible()

      // 900×670 默认窗口：操作列完整可见，设置页不横向溢出
      for (const size of [
        { width: 900, height: 670 },
        { width: 560, height: 670 },
        { width: 420, height: 670 }
      ]) {
        await window.setViewportSize(size)
        const editButton = window
          .getByRole('row', { name: /long-model-identifier/ })
          .getByRole('button', { name: '编辑' })
        await expect(editButton).toBeVisible()
        const box = await editButton.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
        const noPageOverflow = await window.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
        expect(noPageOverflow).toBe(true)
      }

      await app.close()
    } finally {
      await server.close()
    }
  })
})
