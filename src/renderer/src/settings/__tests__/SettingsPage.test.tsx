// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type {
  CreateModelConfigInput,
  DeleteModelConfigInput,
  ModelConfigSummary,
  ModelsApi,
  ModelsConfigList,
  SetActiveModelConfigInput,
  TestDraftModelsConnectionInput,
  TestSavedModelsConnectionInput,
  UpdateModelConfigInput
} from '../../../../shared/models'
import type { PreferencesApi } from '../../../../shared/preferences'
import { createI18n } from '../../i18n'
import { SettingsPage } from '../SettingsPage'

const CONFIG_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const CONFIG_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const CONFIG_C = '11111111-2222-4333-8444-555555555555'

function config(overrides: Partial<ModelConfigSummary> & { id: string }): ModelConfigSummary {
  return {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'gpt-test',
    hasApiKey: false,
    apiKeyUndecryptable: false,
    apiKeyPreview: null,
    ...overrides
  }
}

const KEYLESS_REMOTE = config({ id: CONFIG_A, modelId: 'gpt-test' })
const KEYED_LOCAL = config({
  id: CONFIG_B,
  baseUrl: 'http://127.0.0.1:9000/v1',
  modelId: 'local-model',
  hasApiKey: true,
  apiKeyPreview: 'sk-l••••y-01'
})
const BROKEN_KEY = config({
  id: CONFIG_C,
  baseUrl: 'https://broken.example.com/v1',
  modelId: 'broken-model',
  apiKeyUndecryptable: true
})

function preferencesStub(): PreferencesApi {
  return {
    async getLanguageSettings() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    },
    async setUiLanguage() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    },
    async setTargetLanguage() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    }
  }
}

interface ModelsApiStub {
  api: ModelsApi
  calls: {
    create: CreateModelConfigInput[]
    update: UpdateModelConfigInput[]
    delete: DeleteModelConfigInput[]
    setActive: SetActiveModelConfigInput[]
    testSaved: TestSavedModelsConnectionInput[]
    testDraft: TestDraftModelsConnectionInput[]
    cancel: string[]
    reloads: number
  }
  // 直接改写内存集合，模拟 Main 返回的列表
  setList(list: ModelsConfigList): void
}

function modelsApiStub(
  options: {
    initialList?: ModelsConfigList
    readFails?: boolean
    deleteFails?: boolean
    saveFails?: boolean
    testResult?: 'ok' | 'authFailed'
    pendingTest?: boolean
  } = {}
): ModelsApiStub {
  const calls: ModelsApiStub['calls'] = {
    create: [],
    update: [],
    delete: [],
    setActive: [],
    testSaved: [],
    testDraft: [],
    cancel: [],
    reloads: 0
  }
  let nextId = 0
  let list: ModelsConfigList = options.initialList ?? { activeConfigId: null, configs: [] }
  // 模拟 Main 的取消语义：cancelTest 让在途测试以 TEST_CANCELLED 结束。
  let resolvePendingTest: ((outcome: 'ok' | 'authFailed' | 'cancelled') => void) | undefined
  const pendingOutcome = options.pendingTest
    ? new Promise<'ok' | 'authFailed' | 'cancelled'>((resolve) => {
        resolvePendingTest = resolve
      })
    : undefined
  const testResult = async (): Promise<
    { status: 'ok' } | { status: 'error'; error: { code: 'TEST_AUTH_FAILED' | 'TEST_CANCELLED' } }
  > => {
    const outcome = (await pendingOutcome) ?? options.testResult ?? 'ok'
    if (outcome === 'ok') return { status: 'ok' }
    if (outcome === 'cancelled') {
      return { status: 'error', error: { code: 'TEST_CANCELLED' } }
    }
    return { status: 'error', error: { code: 'TEST_AUTH_FAILED' } }
  }
  const api: ModelsApi = {
    async listConfigs() {
      calls.reloads += 1
      if (options.readFails) {
        return { status: 'error', error: { code: 'MODELS_READ_FAILED' } }
      }
      return { status: 'ok', list }
    },
    async createConfig(input) {
      calls.create.push(input)
      if (options.saveFails) {
        return { status: 'error', error: { code: 'MODELS_WRITE_FAILED' } }
      }
      nextId += 1
      const created = config({
        id: `created-${nextId}`,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        hasApiKey: input.credential.action === 'replace',
        // 模拟 Main 生成的脱敏预览；stub 使用的短密钥整段掩码
        apiKeyPreview: input.credential.action === 'replace' ? '••••••••' : null
      })
      list = {
        activeConfigId: list.configs.length === 0 ? created.id : list.activeConfigId,
        configs: [...list.configs, created]
      }
      return { status: 'ok', list }
    },
    async updateConfig(input) {
      calls.update.push(input)
      if (options.saveFails) {
        return { status: 'error', error: { code: 'MODELS_WRITE_FAILED' } }
      }
      list = {
        ...list,
        configs: list.configs.map((item) =>
          item.id === input.configId
            ? {
                ...item,
                protocol: input.protocol,
                baseUrl: input.baseUrl,
                modelId: input.modelId,
                hasApiKey:
                  input.credential.action === 'replace'
                    ? true
                    : input.credential.action === 'remove'
                      ? false
                      : item.hasApiKey,
                apiKeyUndecryptable:
                  input.credential.action === 'keep' ? item.apiKeyUndecryptable : false,
                apiKeyPreview:
                  input.credential.action === 'replace'
                    ? '••••••••'
                    : input.credential.action === 'remove'
                      ? null
                      : item.apiKeyPreview
              }
            : item
        )
      }
      return { status: 'ok', list }
    },
    async deleteConfig(input) {
      calls.delete.push(input)
      if (options.deleteFails) {
        return { status: 'error', error: { code: 'MODELS_WRITE_FAILED' } }
      }
      list = {
        activeConfigId: list.activeConfigId === input.configId ? null : list.activeConfigId,
        configs: list.configs.filter((item) => item.id !== input.configId)
      }
      return { status: 'ok', list }
    },
    async setActiveConfig(input) {
      calls.setActive.push(input)
      list = { ...list, activeConfigId: input.configId }
      return { status: 'ok', list }
    },
    async testSavedConnection(input) {
      calls.testSaved.push(input)
      return testResult()
    },
    async testDraftConnection(input) {
      calls.testDraft.push(input)
      return testResult()
    },
    async cancelTest(input) {
      calls.cancel.push(input.requestId)
      resolvePendingTest?.('cancelled')
      return { status: 'ok' }
    }
  }
  return {
    api,
    calls,
    setList(next) {
      list = next
    }
  }
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
  vi.stubGlobal('api', {
    // 聊天平台区块随设置页挂载：提供静默桩满足 hook 订阅与状态读取。
    chatChannels: {
      getStatus: async () => ({
        status: 'ok',
        connection: null,
        binding: null,
        pendingBindingRequest: null
      }),
      configureConnection: async () => ({ status: 'error', error: { code: 'NO_CONNECTION' } }),
      connect: async () => ({ status: 'error', error: { code: 'NO_CONNECTION' } }),
      disconnect: async () => ({ status: 'error', error: { code: 'NOT_CONNECTED' } }),
      issueBindingCode: async () => ({ status: 'error', error: { code: 'NO_CONNECTION' } }),
      confirmBinding: async () => ({
        status: 'error',
        error: { code: 'NO_PENDING_BINDING_REQUEST' }
      }),
      rejectBinding: async () => ({
        status: 'error',
        error: { code: 'NO_PENDING_BINDING_REQUEST' }
      }),
      unbind: async () => ({ status: 'error', error: { code: 'NO_ACTIVE_BINDING' } }),
      onEvent: () => () => {}
    },
    preferences: preferencesStub(),
    models
  })
}

async function openModels(list?: ModelsConfigList): Promise<void> {
  void list
  fireEvent.click(screen.getByRole('button', { name: '模型' }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '新增模型' })).toBeEnabled()
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
  it('renders the menu with the ui language section active and its detail', () => {
    installApi(modelsApiStub().api)
    renderPage()

    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    const menuItem = screen.getByRole('button', { name: '界面语言' })
    expect(menuItem).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('navigation', { name: '设置菜单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '界面语言' })).toBeInTheDocument()
    // 字段组以区块标题命名；菜单、标题与图例同名但角色各异
    expect(screen.getByRole('group', { name: '界面语言' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeInTheDocument()
  })

  it('registers ui language, target language, and models sections in order', async () => {
    installApi(modelsApiStub().api)
    renderPage()

    const menuItems = screen
      .getAllByRole('button')
      .filter((button) => ['界面语言', '目标学习语言', '模型'].includes(button.textContent ?? ''))
    expect(menuItems.map((button) => button.textContent)).toEqual([
      '界面语言',
      '目标学习语言',
      '模型'
    ])

    // 目标学习语言区块默认未选中，可切换并显示首版能力说明
    fireEvent.click(screen.getByRole('button', { name: '目标学习语言' }))
    expect(screen.getByRole('button', { name: '目标学习语言' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByRole('heading', { name: '目标学习语言' })).toBeInTheDocument()
    expect(screen.getByText('目前仅支持学习英语。')).toBeInTheDocument()

    await openModels()

    expect(screen.getByRole('button', { name: '模型' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('heading', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByText('还没有已配置的模型')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增模型' })).toBeInTheDocument()
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

  it('shows a read failure with a retry action and never treats it as unconfigured', async () => {
    const { api, calls } = modelsApiStub({ readFails: true })
    installApi(api)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '模型' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取模型配置。')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 读取失败不渲染表格或表单，不误判成首次未配置
    expect(screen.queryByRole('button', { name: '新增模型' })).not.toBeInTheDocument()
    expect(calls.reloads).toBe(1)
  })

  it('renders one row per saved config with masked, missing, and undecryptable keys', async () => {
    installApi(
      modelsApiStub({
        initialList: {
          activeConfigId: CONFIG_A,
          configs: [KEYLESS_REMOTE, KEYED_LOCAL, BROKEN_KEY]
        }
      }).api
    )
    renderPage()

    await openModels()

    const table = screen.getByRole('table', { name: '已保存的模型配置列表' })
    expect(table).toBeInTheDocument()
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
    expect(headers).toEqual(['Model ID', 'Base URL', 'API Key', '操作'])

    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4) // 表头 + 3 行
    expect(within(rows[1]).getByText('gpt-test')).toBeInTheDocument()
    expect(within(rows[1]).getByText('未配置')).toBeInTheDocument()
    // 已配置密钥只显示脱敏预览：前 4 位与后 4 位，中间整段掩码
    expect(within(rows[2]).getByText('sk-l••••y-01')).toBeInTheDocument()
    expect(within(rows[3]).getByText('密钥不可用，请重新配置')).toBeInTheDocument()
    // 长地址保留完整内容于 title
    expect(within(rows[2]).getByTitle('http://127.0.0.1:9000/v1')).toBeInTheDocument()
    // 最右列提供三个动作；表格内不再展示协议与测试状态
    for (const row of rows.slice(1)) {
      expect(within(row).getByRole('button', { name: '删除' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: '编辑' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: '测试连通' })).toBeInTheDocument()
      expect(within(row).queryByText('OpenAI 兼容')).not.toBeInTheDocument()
    }
  })

  it('saves and reloads the Gemini protocol in the model form', async () => {
    const { api, calls } = modelsApiStub()
    installApi(api)
    renderPage()
    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fireEvent.change(screen.getByRole('combobox', { name: '接口类型' }), {
      target: { value: 'gemini' }
    })
    fillForm('https://example.com/gemini/v1beta', 'gemini-test')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.create[0]).toMatchObject({ protocol: 'gemini' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('combobox', { name: '接口类型' })).toHaveValue('gemini')
  })

  it('creates a config from an empty form and auto-selects the first one as current', async () => {
    const { api, calls } = modelsApiStub()
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    expect(screen.getByRole('heading', { name: '新增模型' })).toBeInTheDocument()
    // 无修改时保存禁用
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    fillForm('http://127.0.0.1:9000/v1/', 'local-model')
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: ' secret ' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(calls.create).toEqual([
        {
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9000/v1',
          modelId: 'local-model',
          credential: { action: 'replace', apiKey: 'secret' }
        }
      ])
    })
    // 表单关闭，表格出现新行，第一条自动成为当前模型
    expect(await screen.findByText('local-model')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '新增模型' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('当前使用模型')).toHaveValue('created-1')
  })

  it('edits a config without refilling the key and keeps it by explicit intent', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_B, configs: [KEYED_LOCAL] }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(screen.getByRole('heading', { name: '编辑模型' })).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://127.0.0.1:9000/v1')
    expect(screen.getByLabelText('Model ID')).toHaveValue('local-model')
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByText('已配置')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'renamed-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(calls.update).toEqual([
        {
          configId: CONFIG_B,
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9000/v1',
          modelId: 'renamed-model',
          credential: { action: 'keep' }
        }
      ])
    })
    expect(await screen.findByText('renamed-model')).toBeInTheDocument()
    // 编辑保持当前模型选择不变
    expect(screen.getByLabelText('当前使用模型')).toHaveValue(CONFIG_B)
  })

  it('removes an undecryptable stored key through the edit form', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_C, configs: [BROKEN_KEY] }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '移除已保存的密钥' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(calls.update[0]).toMatchObject({
        configId: CONFIG_C,
        credential: { action: 'remove' }
      })
    })
    expect(await screen.findByText('未配置')).toBeInTheDocument()
  })

  it('cancels an unchanged form directly and returns focus to the edit button', async () => {
    const { api } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    renderPage()
    await openModels()

    const editButton = screen.getByRole('button', { name: '编辑' })
    fireEvent.click(editButton)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('heading', { name: '编辑模型' })).not.toBeInTheDocument()
    expect(editButton).toHaveFocus()
  })

  it('asks before discarding unsaved edits when switching edit targets or closing', async () => {
    const { api } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE, KEYED_LOCAL] }
    })
    installApi(api)
    renderPage()
    await openModels()

    const rows = screen.getAllByRole('row')
    fireEvent.click(within(rows[1]).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'changed' } })

    // 切换编辑目标先确认
    fireEvent.click(within(rows[2]).getByRole('button', { name: '编辑' }))
    const dialog = screen.getByRole('dialog', { name: '有未保存的修改' })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByLabelText('Model ID')).toHaveValue('changed')

    // 取消表单同样先确认；放弃后加载另一条记录
    fireEvent.click(within(rows[2]).getByRole('button', { name: '编辑' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '有未保存的修改' })).getByRole('button', {
        name: '放弃修改'
      })
    )
    expect(await screen.findByLabelText('Model ID')).toHaveValue('local-model')
  })

  it('blocks saving without valid changes and validates fields before submit', async () => {
    const { api, calls } = modelsApiStub()
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fillForm('not a url', '')
    fireEvent.click(screen.getByRole('button', { name: '测试草稿' }))

    expect(await screen.findByText(/Base URL 无效/)).toBeInTheDocument()
    expect(screen.getByText('Model ID 不能为空。')).toBeInTheDocument()
    expect(calls.testDraft).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })

  it('keeps the draft and shows a failure when saving fails', async () => {
    const { api } = modelsApiStub({ saveFails: true })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存模型配置失败，请重试。')).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    // 保存按钮在失败后可重试
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('reports cross-origin keep as a field error on the API key', async () => {
    const { api } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_B, configs: [KEYED_LOCAL] }
    })
    api.updateConfig = async () => ({
      status: 'error',
      error: { code: 'CROSS_ORIGIN_CREDENTIAL', field: 'apiKey' }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://other.example.com/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/Base URL 的源已变化，不允许沿用旧密钥/)).toBeInTheDocument()
  })

  it('deletes a row after confirming the identified target', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE, KEYED_LOCAL] }
    })
    installApi(api)
    renderPage()
    await openModels()

    const rows = screen.getAllByRole('row')
    fireEvent.click(within(rows[2]).getByRole('button', { name: '删除' }))

    const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
    expect(
      within(dialog).getByText(/local-model（http:\/\/127\.0\.0\.1:9000\/v1）/)
    ).toBeInTheDocument()
    // 非当前模型的删除不提示重新选择
    expect(within(dialog).queryByText(/重新选择/)).not.toBeInTheDocument()
    expect(calls.delete).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(calls.delete).toEqual([{ configId: CONFIG_B }])
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('row', { name: /gpt-test/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /local-model/ })).not.toBeInTheDocument()
    // 删除的是最后一行：没有下一行，焦点移至新增入口
    expect(screen.getByRole('button', { name: '新增模型' })).toHaveFocus()
  })

  it('warns about reselecting when deleting the current model and clears the selection', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE, KEYED_LOCAL] }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(within(screen.getAllByRole('row')[1]).getByRole('button', { name: '删除' }))

    const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
    expect(within(dialog).getByText(/删除后需要重新选择模型/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(calls.delete).toEqual([{ configId: CONFIG_A }])
    })
    // 当前模型为空时提示显式选择，选择器回到占位项
    expect(await screen.findByText('请选择当前使用的模型。')).toBeInTheDocument()
    expect(screen.getByLabelText('当前使用模型')).toHaveValue('')
  })

  it('notes discarded drafts when deleting the row being edited and keeps failures retryable', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
    expect(within(dialog).getByText(/未保存的修改，将一并丢弃/)).toBeInTheDocument()

    api.deleteConfig = async () => ({ status: 'error', error: { code: 'MODELS_WRITE_FAILED' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    expect(await screen.findByText('删除模型配置失败，请重试。')).toBeInTheDocument()
    // 失败保持原行与编辑表单
    expect(screen.getByRole('heading', { name: '编辑模型' })).toBeInTheDocument()

    api.deleteConfig = async (input) => {
      calls.delete.push(input)
      return {
        status: 'ok',
        list: { activeConfigId: null, configs: [] }
      }
    }
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))

    await waitFor(() => {
      expect(screen.getByText('还没有已配置的模型')).toBeInTheDocument()
    })
    // 编辑草稿随删除清理
    expect(screen.queryByRole('heading', { name: '编辑模型' })).not.toBeInTheDocument()
    // 空列表后焦点移至新增入口
    expect(screen.getByRole('button', { name: '新增模型' })).toHaveFocus()
  })

  it('cancelling a delete confirmation keeps the data untouched', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.delete).toHaveLength(0)
    expect(screen.getByRole('row', { name: /gpt-test/ })).toBeInTheDocument()
  })

  it('selects the current model through the selector', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: null, configs: [KEYLESS_REMOTE, KEYED_LOCAL] }
    })
    installApi(api)
    renderPage()
    await openModels()

    expect(screen.getByText('请选择当前使用的模型。')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('当前使用模型'), { target: { value: CONFIG_B } })

    await waitFor(() => {
      expect(calls.setActive).toEqual([{ configId: CONFIG_B }])
    })
    await waitFor(() => {
      expect(screen.getByLabelText('当前使用模型')).toHaveValue(CONFIG_B)
    })
    expect(screen.queryByText('请选择当前使用的模型。')).not.toBeInTheDocument()
  })

  it('shows a row test result in a dialog identifying the tested config', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE, KEYED_LOCAL] },
      testResult: 'authFailed'
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(within(screen.getAllByRole('row')[1]).getByRole('button', { name: '测试连通' }))

    await waitFor(() => {
      expect(calls.testSaved).toHaveLength(1)
    })
    const dialog = await screen.findByRole('dialog', { name: '连接测试' })
    // 弹窗标明被测配置，表格内不再展示逐行测试状态
    expect(
      within(dialog).getByText('测试对象：gpt-test（https://api.example.com/v1）')
    ).toBeInTheDocument()
    expect(within(dialog).getByText('鉴权失败，请检查 API Key。')).toBeInTheDocument()
    expect(within(screen.getAllByRole('row')[2]).queryByText('未测试')).not.toBeInTheDocument()

    // 关闭弹窗后可再次发起测试
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      within(screen.getAllByRole('row')[1]).getByRole('button', { name: '测试连通' })
    ).toBeEnabled()
  })

  it('cancels the in-flight test when the result dialog is closed via Escape', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] },
      pendingTest: true
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '测试连通' }))
    const dialog = await screen.findByRole('dialog', { name: '连接测试' })
    expect(within(dialog).getByText('正在测试连接…')).toBeInTheDocument()
    // 弹窗打开即聚焦其按钮：触发按钮已禁用，焦点落在 body 会让 Escape 收不到
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()

    // Escape 关闭弹窗：在途测试被取消，锁定释放后可再次测试。
    // 焦点被约束在弹窗内，按键从弹窗内发起，不冒泡到页面。
    fireEvent.keyDown(screen.getByRole('dialog', { name: '连接测试' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(calls.cancel).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '测试连通' })).toBeEnabled()
    })
  })

  it('cancels the in-flight test when the dialog cancel button is clicked', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] },
      pendingTest: true
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '测试连通' }))
    const dialog = await screen.findByRole('dialog', { name: '连接测试' })

    // “取消”按钮关闭弹窗同样取消在途测试
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(calls.cancel).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '测试连通' })).toBeEnabled()
    })
  })

  it('locks other test entries and the tested row during a row test', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE, KEYED_LOCAL] },
      pendingTest: true
    })
    installApi(api)
    renderPage()
    await openModels()

    const rows = screen.getAllByRole('row')
    fireEvent.click(within(rows[1]).getByRole('button', { name: '测试连通' }))

    // 测试进度在弹窗中呈现
    const dialog = await screen.findByRole('dialog', { name: '连接测试' })
    expect(within(dialog).getByText('正在测试连接…')).toBeInTheDocument()
    const testedRow = screen.getAllByRole('row')[1]
    const otherRow = screen.getAllByRole('row')[2]
    expect(within(testedRow).getByRole('button', { name: '编辑' })).toBeDisabled()
    expect(within(testedRow).getByRole('button', { name: '删除' })).toBeDisabled()
    expect(within(otherRow).getByRole('button', { name: '测试连通' })).toBeDisabled()
    // 其他行仍可编辑
    expect(within(otherRow).getByRole('button', { name: '编辑' })).toBeEnabled()

    // 切到 Language：中止测试但不弹放弃确认
    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))
    await waitFor(() => {
      expect(calls.cancel).toHaveLength(1)
    })
    expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()

    // 切回 Models：取消结果落在弹窗中，关闭后可再次测试
    await openModels()
    const reopenedDialog = await screen.findByRole('dialog', { name: '连接测试' })
    expect(within(reopenedDialog).getByText('已取消')).toBeInTheDocument()
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      within(screen.getAllByRole('row')[1]).getByRole('button', { name: '测试连通' })
    ).toBeEnabled()
  })

  it('tests the draft from the form with the edit target declared', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_B, configs: [KEYED_LOCAL] },
      testResult: 'ok'
    })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '测试草稿' }))

    await waitFor(() => {
      expect(calls.testDraft).toHaveLength(1)
    })
    expect(calls.testDraft[0]).toMatchObject({
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9000/v1',
      modelId: 'local-model',
      credential: { action: 'keep' },
      editTargetConfigId: CONFIG_B
    })
    expect(await screen.findByText('连接测试成功。')).toBeInTheDocument()
    // 草稿结果只留在表单内，不打开行测试弹窗
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // 修改表单后旧测试结果清除
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-other' } })
    expect(screen.queryByText('连接测试成功。')).not.toBeInTheDocument()
  })

  it('locks the form while a draft test is running', async () => {
    const { api } = modelsApiStub({ pendingTest: true })
    installApi(api)
    renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '测试草稿' }))

    expect(await screen.findByText('正在测试连接…')).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toBeDisabled()
    expect(screen.getByRole('button', { name: '测试草稿' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  })

  it('uses Escape to close the form first and exits only when nothing is open', async () => {
    const { api } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    const onExit = renderPage()
    await openModels()

    // 打开表单后 Escape 关闭表单，不退出设置
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    expect(screen.queryByRole('heading', { name: '编辑模型' })).not.toBeInTheDocument()
    expect(onExit).not.toHaveBeenCalled()

    // 有未保存修改时 Escape 打开弃改确认；确认层内 Escape 回到编辑
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'changed' } })
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    const dialog = screen.getByRole('dialog', { name: '有未保存的修改' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByLabelText('Model ID')).toHaveValue('changed')
    expect(onExit).not.toHaveBeenCalled()

    // 放弃修改后再次 Escape 才退出
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '有未保存的修改' })).getByRole('button', {
        name: '放弃修改'
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('uses the page exit confirmation on language with a hidden model draft', async () => {
    installApi(modelsApiStub().api)
    const onExit = renderPage()
    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fillForm('https://api.example.com/v1', 'draft-model')
    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))

    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    const dialog = screen.getByRole('dialog', { name: '有未保存的修改' })
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('button', { name: '继续编辑' })).toHaveFocus()
    expect(onExit).not.toHaveBeenCalled()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await openModels()
    expect(screen.getByLabelText('Model ID')).toHaveValue('draft-model')

    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))
    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '放弃修改' }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('Escape closes a delete confirmation before anything else', async () => {
    const { api, calls } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    const onExit = renderPage()
    await openModels()

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    // 焦点被约束在确认弹窗内，Escape 从弹窗内发起并吞在遮罩层
    fireEvent.keyDown(screen.getByRole('dialog', { name: '删除模型配置？' }), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.delete).toHaveLength(0)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('asks for confirmation before exiting with unsaved model changes', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    const onExit = renderPage()

    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
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

  it('exits without confirmation when the models draft is untouched', async () => {
    const { api } = modelsApiStub({
      initialList: { activeConfigId: CONFIG_A, configs: [KEYLESS_REMOTE] }
    })
    installApi(api)
    const onExit = renderPage()

    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(onExit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the models draft across section switches within one settings visit', async () => {
    const { api } = modelsApiStub()
    installApi(api)
    renderPage()

    await openModels()
    fireEvent.click(screen.getByRole('button', { name: '新增模型' }))
    fillForm('https://api.example.com/v1', 'gpt-test')
    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))
    await openModels()

    expect(screen.getByRole('heading', { name: '新增模型' })).toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    expect(screen.getByLabelText('Model ID')).toHaveValue('gpt-test')
  })
})

function withinDialog(dialog: HTMLElement, name: string): HTMLElement {
  const button = screen.getAllByRole('button', { name }).at(-1)
  if (!button || !dialog.contains(button)) throw new Error(`button ${name} not in dialog`)
  return button
}
