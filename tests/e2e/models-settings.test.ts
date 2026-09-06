import {
  expect,
  launchApp,
  startFakeModelServer,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

test('configures a model through Settings > Models and uses it for real conversations', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const server = await startFakeModelServer()
    try {
      // 远程模式启动：尚未配置模型
      const firstLaunch = await launchApp(userDataPath, { model: 'remote' })
      const window = await firstLaunch.firstWindow()
      await waitForReady(window)

      await window.fill('#message', '你好')
      await window.press('#message', 'Enter')
      await expect(window.locator('.status')).toContainText('尚未配置模型', { timeout: 15_000 })

      // 进入设置 → Models：菜单第二项，右侧出现表单
      await window.click('.settings-button')
      await expect(window.locator('main.settings-page')).toBeVisible()
      await window.getByRole('button', { name: '模型' }).click()
      const modelsPane = window.locator('.settings-detail-pane', { hasText: 'OpenAI 兼容' })
      await expect(modelsPane).toBeVisible()
      await expect(window.locator('#models-base-url')).toHaveValue('')

      // 填写草稿后出现未保存确认：继续编辑保留草稿
      await window.fill('#models-base-url', `${server.baseUrl}/v1`)
      await window.fill('#models-model-id', 'fake-model')
      await window.click('.settings-back-button')
      const discardDialog = window.locator('.settings-confirm')
      await expect(discardDialog).toBeVisible()
      await discardDialog.getByRole('button', { name: '继续编辑' }).click()
      await expect(window.locator('#models-base-url')).toHaveValue(`${server.baseUrl}/v1`)

      // 测试连接成功与保存成功分别展示
      await window.getByRole('button', { name: '测试连接' }).click()
      await expect(window.locator('.models-status')).toContainText('连接测试成功', {
        timeout: 15_000
      })
      await window.getByRole('button', { name: '保存' }).click()
      await expect(window.locator('.models-status')).toContainText('已保存。')

      // 保存成功后退出不再拦截
      await window.click('.settings-back-button')
      await expect(window.locator('main.settings-page')).toBeHidden()

      // 已保存配置用于真实对话（流式分片来自假服务）
      await window.fill('#message', '开始练习')
      await window.press('#message', 'Enter')
      await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
      await expect(window.locator('.message.assistant').last()).toContainText('这是假模型')

      await firstLaunch.close()

      // 重启后配置仍有效，密钥永不回填
      const secondLaunch = await launchApp(userDataPath, { model: 'remote' })
      const secondWindow = await secondLaunch.firstWindow()
      await waitForReady(secondWindow)
      await secondWindow.click('.settings-button')
      await secondWindow.getByRole('button', { name: '模型' }).click()
      await expect(secondWindow.locator('#models-base-url')).toHaveValue(`${server.baseUrl}/v1`)
      await expect(secondWindow.locator('#models-model-id')).toHaveValue('fake-model')
      await expect(secondWindow.locator('#models-api-key')).toHaveValue('')
      await expect(secondWindow.getByText('未配置')).toBeVisible()

      // 清除配置需要确认，完成后回到未配置状态
      await secondWindow.getByRole('button', { name: '清除配置' }).click()
      const clearDialog = secondWindow.locator('.settings-confirm')
      await expect(clearDialog).toBeVisible()
      await clearDialog.getByRole('button', { name: '清除' }).click()
      await expect(secondWindow.locator('#models-base-url')).toHaveValue('')
      await expect(secondWindow.getByRole('button', { name: '清除配置' })).toBeHidden()

      await secondLaunch.close()
    } finally {
      await server.close()
    }
  })
})
