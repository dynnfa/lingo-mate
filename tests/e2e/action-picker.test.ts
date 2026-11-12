import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference
} from './helpers'

// `/` 行动选择器的实窗验收：定位、焦点与原生事件行为无法只靠 jsdom 断言。
test('opens the slash action picker above the composer and selects an action', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    const input = window.locator('#message')
    await input.click()
    await input.fill('/')

    const picker = window.locator('.action-picker')
    await expect(picker).toBeVisible()
    await expect(window.locator('.action-picker-option')).toHaveCount(7)

    // 弹层锚定输入行正上方并覆盖消息区域，不挤压消息布局
    const pickerBox = await picker.boundingBox()
    const rowBox = await window.locator('.composer > div').boundingBox()
    expect(pickerBox).toBeTruthy()
    expect(rowBox).toBeTruthy()
    if (pickerBox && rowBox) {
      const pickerBottom = pickerBox.y + pickerBox.height
      // bottom: 100% 相对 padding box 定位，宽度允许 2px 边框差
      expect(pickerBottom).toBeLessThanOrEqual(rowBox.y + 1)
      expect(Math.abs(pickerBox.x - rowBox.x)).toBeLessThan(3)
      expect(Math.abs(pickerBox.width - rowBox.width)).toBeLessThan(3)
    }

    // 键盘：下移再上移高亮，Enter 选择，焦点留在输入框
    await input.press('ArrowDown')
    await expect(window.locator('.action-picker-option.highlighted')).toHaveText(/收藏词汇/)
    await input.press('ArrowUp')
    await expect(window.locator('.action-picker-option.highlighted')).toHaveText(/概念讲解/)
    await input.press('Enter')
    await expect(input).toHaveValue('/concept ')
    await expect(picker).toBeHidden()
    expect(await input.evaluate((el) => document.activeElement === el)).toBe(true)

    // 选择后的草稿继续补充参数不弹回，并按既有流程以字面命令文本发送
    await input.type('这句话')
    await expect(picker).toBeHidden()
    await input.press('Enter')
    await expect(window.locator('.message.user')).toContainText('/concept 这句话')

    // 发送清空草稿后，新一轮 `/` 输入不应继承上一次选择的关闭抑制。
    await expect(input).toBeEnabled()
    await input.click()
    await input.fill('/')
    await expect(picker).toBeVisible()
    await expect(window.locator('.action-picker-option.highlighted')).toHaveText(/概念讲解/)

    await app.close()
  })
})

test('submits an unknown slash command as ordinary conversation', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    const input = window.locator('#message')
    await input.click()
    await input.fill('/zzz')

    await expect(window.locator('.action-picker')).toBeHidden()
    await expect(window.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await input.press('Enter')
    await expect(window.locator('.message.user')).toContainText('/zzz')

    await app.close()
  })
})

test('closes the picker on outside click and reopens on refocus', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const app = await launchApp(userDataPath)
    const window = await app.firstWindow()
    await waitForReady(window)

    const input = window.locator('#message')
    await input.click()
    await input.fill('/')
    await expect(window.locator('.action-picker')).toBeVisible()

    // 点击输入区之外（消息区域）即关闭，草稿保留
    await window.locator('.messages').click({ position: { x: 10, y: 10 } })
    await expect(window.locator('.action-picker')).toBeHidden()
    await expect(input).toHaveValue('/')

    // 隐式关闭后重新聚焦输入框可以重开
    await input.click()
    await expect(window.locator('.action-picker')).toBeVisible()

    await app.close()
  })
})
