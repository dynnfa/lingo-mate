// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  ModelsApi,
  ModelsSettingsSummary,
  SaveModelsSettingsInput,
  TestModelsConnectionInput
} from '../../../../shared/models'
import type { PreferencesApi } from '../../../../shared/preferences'
import { createI18n } from '../../i18n'
import { SettingsPage } from '../SettingsPage'

function preferencesStub(): PreferencesApi {
  return {
    async getLocale() {
      return { status: 'ok', settings: { preference: 'system', resolvedLocale: 'zh-CN' } }
    },
    async setLocale() {
      return { status: 'ok', settings: { preference: 'system', resolvedLocale: 'zh-CN' } }
    }
  }
}

const UNCONFIGURED_SUMMARY: ModelsSettingsSummary = { configured: false }

const CONFIGURED_SUMMARY: ModelsSettingsSummary = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  hasApiKey: false,
  apiKeyUndecryptable: false
}

interface ModelsApiStub {
  api: ModelsApi
  calls: {
    save: SaveModelsSettingsInput[]
    test: TestModelsConnectionInput[]
    cancel: string[]
    clear: number
    reloads: number
  }
}

function modelsApiStub(
  options: {
    summary?: ModelsSettingsSummary
    saveSummary?: ModelsSettingsSummary
    testResult?: 'ok' | 'authFailed'
    readFails?: boolean
    pendingTest?: boolean
  } = {}
): ModelsApiStub {
  const calls: ModelsApiStub['calls'] = { save: [], test: [], cancel: [], clear: 0, reloads: 0 }
  // 模拟 Main 的取消语义：cancelTest 让在途测试以 TEST_CANCELLED 结束。
  let resolvePendingTest: ((outcome: 'ok' | 'authFailed' | 'cancelled') => void) | undefined
  const pendingOutcome = options.pendingTest
    ? new Promise<'ok' | 'authFailed' | 'cancelled'>((resolve) => {
        resolvePendingTest = resolve
      })
    : undefined
  const api: ModelsApi = {
    async getSettings() {
      calls.reloads += 1
      if (options.readFails) {
        return { status: 'error', error: { code: 'MODELS_READ_FAILED' } }
      }
      return { status: 'ok', summary: options.summary ?? UNCONFIGURED_SUMMARY }
    },
    async saveSettings(input) {
      calls.save.push(input)
      return { status: 'ok', summary: options.saveSummary ?? CONFIGURED_SUMMARY }
    },
    async testConnection(input) {
      calls.test.push(input)
      const outcome = (await pendingOutcome) ?? options.testResult ?? 'ok'
      if (outcome === 'ok') return { status: 'ok' }
      if (outcome === 'cancelled') {
        return { status: 'error', error: { code: 'TEST_CANCELLED' } }
      }
      return { status: 'error', error: { code: 'TEST_AUTH_FAILED' } }
    },
    async cancelTest(input) {
      calls.cancel.push(input.requestId)
      resolvePendingTest?.('cancelled')
      return { status: 'ok' }
    },
    async clearSettings() {
      calls.clear += 1
      return { status: 'ok', summary: UNCONFIGURED_SUMMARY }
    }
  }
  return { api, calls }
}

function renderPage(
  onExit = vi.fn(),
  models: ModelsApi = modelsApiStub().api
): ReturnType<typeof vi.fn> {
  const i18n = createI18n('zh-CN')
  render(
    <I18nextProvider i18n={i18n}>
      <SettingsPage onExit={onExit} />
    </I18nextProvider>
  )
  void models
  return onExit
}

function installApi(models: ModelsApi): void {
  vi.stubGlobal('api', { preferences: preferencesStub(), models })
}

async function openModels(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '模型' }))
  // 等待摘要读取完成，表单字段可用。
  await waitFor(() => {
    expect(screen.getByLabelText('Base URL')).toBeEnabled()
  })
}

function fillForm(baseUrl: string, modelId: string): void {
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: baseUrl } })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: modelId } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SettingsPage', () => {
  it('lets the user remove an undecryptable key without clearing other settings', async () => {
    const { api, calls } = modelsApiStub({
      summary: { ...CONFIGURED_SUMMARY, apiKeyUndecryptable: true }
    })
    installApi(api)
    renderPage()
    await openModels()
    fireEvent.click(screen.getByRole('checkbox', { name: '移除已保存的密钥' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存。')
    expect(calls.save[0]).toMatchObject({
      baseUrl: CONFIGURED_SUMMARY.baseUrl,
      modelId: CONFIGURED_SUMMARY.modelId,
      credential: { action: 'remove' }
    })
  })

  it('resets the draft to normalized saved values and exits without confirmation', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    const onExit = renderPage()
    await openModels()
    fillForm('https://api.example.com/v1/', ' gpt-test ')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存。')
    expect(screen.getByLabelText('Base URL')).toHaveValue(CONFIGURED_SUMMARY.baseUrl)
    expect(screen.getByLabelText('Model ID')).toHaveValue(CONFIGURED_SUMMARY.modelId)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onExit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['ok', 'authFailed'] as const)(
    'keeps the %s test outcome visible after saving',
    async (testResult) => {
      const { api } = modelsApiStub({ testResult })
      installApi(api)
      renderPage()
      await openModels()
      fillForm(CONFIGURED_SUMMARY.baseUrl, CONFIGURED_SUMMARY.modelId)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByText('已保存。')
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      expect(
        await screen.findByText(
          testResult === 'ok' ? '连接测试成功。' : '鉴权失败，请检查 API Key。'
        )
      ).toBeVisible()
      expect(screen.getByText('已保存。')).toBeVisible()
    }
  )

  it('renders the menu with the language section active and its detail', () => {
    installApi(modelsApiStub().api)
    renderPage()

    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    const menuItem = screen.getByRole('button', { name: '语言' })
    expect(menuItem).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('navigation', { name: '设置菜单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '语言' })).toBeInTheDocument()
    expect(screen.getByText('界面语言')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeInTheDocument()
  })

  it('registers the models section after language and shows its detail on demand', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    renderPage()

    const menuItems = screen
      .getAllByRole('button')
      .filter((button) => ['语言', '模型'].includes(button.textContent ?? ''))
    expect(menuItems.map((button) => button.textContent)).toEqual(['语言', '模型'])

    await openModels()

    expect(screen.getByRole('button', { name: '模型' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('heading', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByText('OpenAI 兼容')).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('')
    expect(screen.getByLabelText('Model ID')).toHaveValue('')
  })

  it('moves focus to the back button when mounted', () => {
    installApi(modelsApiStub().api)
    renderPage()

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
  })

  it('calls onExit when the back button is clicked', () => {
    installApi(modelsApiStub().api)
    const onExit = renderPage()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('calls onExit when Escape is pressed inside the page', () => {
    installApi(modelsApiStub().api)
    const onExit = renderPage()

    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })

    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('prefills saved settings without ever refilling the API key', async () => {
    installApi(modelsApiStub({ summary: { ...CONFIGURED_SUMMARY, hasApiKey: true } }).api)
    renderPage()

    await openModels()

    expect(screen.getByLabelText('Base URL')).toHaveValue(CONFIGURED_SUMMARY.baseUrl)
    expect(screen.getByLabelText('Model ID')).toHaveValue(CONFIGURED_SUMMARY.modelId)
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByText('已配置')).toBeInTheDocument()
  })

  it('shows a read failure with a retry action and never treats it as unconfigured', async () => {
    const { api, calls } = modelsApiStub({ readFails: true })
    installApi(api)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '模型' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取模型配置。')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 读取失败不渲染可编辑表单，不误判成首次未配置
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    expect(calls.reloads).toBe(1)
  })

  it('blocks saving without valid changes and validates fields before submit', async () => {
    const { api, calls } = modelsApiStub()
    installApi(api)
    renderPage()

    await openModels()

    const saveButton = screen.getByRole('button', { name: '保存' })
    expect(saveButton).toBeDisabled()

    fillForm('not a url', '')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText(/Base URL 无效/)).toBeInTheDocument()
    expect(screen.getByText('Model ID 不能为空。')).toBeInTheDocument()
    expect(calls.test).toHaveLength(0)
    expect(calls.save).toHaveLength(0)
  })

  it('saves the draft with explicit credential intent and clears the key input on success', async () => {
    const { api, calls } = modelsApiStub()
    installApi(api)
    renderPage()

    await openModels()
    fillForm('http://127.0.0.1:9000/v1/', 'local-model')
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: ' secret ' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(calls.save).toEqual([
        {
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9000/v1',
          modelId: 'local-model',
          credential: { action: 'replace', apiKey: 'secret' }
        }
      ])
    })
    expect(await screen.findByText('已保存。')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
  })

  it('keeps the draft and shows a failure when saving fails', async () => {
    const { api } = modelsApiStub()
    const savedInputs: SaveModelsSettingsInput[] = []
    api.saveSettings = async (input) => {
      savedInputs.push(input)
      return { status: 'error', error: { code: 'MODELS_WRITE_FAILED' } }
    }
    installApi(api)
    renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存模型配置失败，请重试。')).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    expect(savedInputs).toHaveLength(1)
    // 保存按钮在失败后可重试
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('reports cross-origin keep as a field error on the API key', async () => {
    const { api } = modelsApiStub({
      summary: { ...CONFIGURED_SUMMARY, hasApiKey: true }
    })
    api.saveSettings = async () => ({
      status: 'error',
      error: { code: 'CROSS_ORIGIN_CREDENTIAL', field: 'apiKey' }
    })
    installApi(api)
    renderPage()

    await openModels()
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://other.example.com/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/Base URL 的源已变化，不允许沿用旧密钥/)).toBeInTheDocument()
  })

  it('shows the connection test result separately from save status', async () => {
    const { api, calls } = modelsApiStub({ testResult: 'authFailed' })
    installApi(api)
    renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    await waitFor(() => {
      expect(calls.test).toHaveLength(1)
    })
    expect(await screen.findByText('鉴权失败，请检查 API Key。')).toBeInTheDocument()

    // 修改表单后旧测试结果清除
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-other' } })
    expect(screen.queryByText('鉴权失败，请检查 API Key。')).not.toBeInTheDocument()
  })

  it('locks the form while a test is running and cancels it when switching sections', async () => {
    const { api, calls } = modelsApiStub({ pendingTest: true })
    installApi(api)
    renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    await waitFor(() => {
      expect(screen.getByText('正在测试连接…')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Base URL')).toBeDisabled()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled()

    // 切到 Language：中止测试但不弹放弃确认、不丢草稿
    fireEvent.click(screen.getByRole('button', { name: '语言' }))
    expect(await screen.findByText('界面语言')).toBeVisible()
    expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(calls.cancel).toHaveLength(1)
    })

    // 切回 Models：草稿保留，取消结果落地后表单恢复可用
    await openModels()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    await waitFor(() => {
      expect(screen.getByText('连接测试已取消。')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
  })

  it('requires confirmation to clear the configuration and resets afterwards', async () => {
    const { api, calls } = modelsApiStub({ summary: CONFIGURED_SUMMARY })
    installApi(api)
    renderPage()

    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '清除配置' }))

    expect(await screen.findByRole('dialog', { name: '清除模型配置？' })).toBeInTheDocument()
    expect(calls.clear).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: '清除' }))

    await waitFor(() => {
      expect(calls.clear).toBe(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(await screen.findByLabelText('Base URL')).toHaveValue('')
    expect(screen.queryByRole('button', { name: '清除配置' })).not.toBeInTheDocument()
  })

  it('keeps the models draft across section switches within one settings visit', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '语言' }))
    await openModels()

    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    expect(screen.getByLabelText('Model ID')).toHaveValue('gpt-test')
  })

  it('asks for confirmation before exiting with unsaved model changes', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    const onExit = renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    const dialog = await screen.findByRole('dialog', { name: '有未保存的修改' })
    expect(onExit).not.toHaveBeenCalled()

    // 继续编辑：留在页面且草稿保留
    fireEvent.click(withinDialog(dialog, '继续编辑'))
    expect(onExit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')

    // 放弃修改：退出设置页
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(
      withinDialog(await screen.findByRole('dialog', { name: '有未保存的修改' }), '放弃修改')
    )
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('asks for confirmation before Escape exits with unsaved model changes', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    const onExit = renderPage()

    await openModels()
    fillForm('https://api.example.com/v1', 'gpt-test')

    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })

    const dialog = await screen.findByRole('dialog', { name: '有未保存的修改' })
    expect(onExit).not.toHaveBeenCalled()

    // 对话框内 Escape 回到编辑，不退出
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onExit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
  })
})

function withinDialog(dialog: HTMLElement, name: string): HTMLElement {
  const button = screen.getAllByRole('button', { name }).at(-1)
  if (!button || !dialog.contains(button)) throw new Error(`button ${name} not in dialog`)
  return button
}
