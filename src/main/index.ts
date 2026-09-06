import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ConversationModule } from '../core/conversation/conversation-module'
import type { SupportedLocale } from '../shared/preferences'
import { ConfiguredLanguageModel } from '../core/llm/configured-language-model'
import { LocalLanguageModel } from '../core/llm/local-language-model'
import { ModelConnectionTester } from '../core/llm/model-connection-tester'
import { ModelConfigService } from '../core/llm/model-config'
import type { LanguageModel } from '../core/llm/language-model'
import { SqliteConversationRepository } from '../database/sqlite-conversation-repository'
import { registerConversationIpc } from './conversation-ipc'
import { registerModelsIpc } from './models-ipc'
import { createFileModelsConfigStore, createSafeStorageCredentialVault } from './models-store'
import { PreferencesService } from './preferences'
import { registerPreferencesIpc } from './preferences-ipc'
import { createElectronPreferenceStore } from './preferences-store'

let conversationRepository: SqliteConversationRepository | undefined

// 加载目标与 IPC 来源白名单使用同一地址，开发模式也只信任指定文档。
const rendererUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  void mainWindow.loadURL(rendererUrl)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  conversationRepository = new SqliteConversationRepository(
    join(app.getPath('userData'), 'lingo-mate.sqlite')
  )

  // 模型配置服务：持久化记录 + 系统安全存储加密密钥；IPC 与对话模型入口共用。
  const modelsService = new ModelConfigService(
    createFileModelsConfigStore(join(app.getPath('userData'), 'models.json')),
    createSafeStorageCredentialVault()
  )
  registerModelsIpc(modelsService, new ModelConnectionTester(), rendererUrl)

  // 生产对话按请求解析已保存配置快照；LocalLanguageModel 仅作为显式开发/测试
  // 模式（LINGO_MATE_MODEL=local），远程请求失败后不自动回退。
  const conversationModel: LanguageModel =
    process.env['LINGO_MATE_MODEL'] === 'local'
      ? new LocalLanguageModel()
      : new ConfiguredLanguageModel(modelsService)

  // 界面语言来源统一由 Main 解析：跟随系统时按系统偏好顺序匹配支持语言。
  // 偏好存储初始化失败只损失语言记忆（Renderer 回退默认语言），不阻断应用启动。
  let preferencesService: PreferencesService | undefined
  try {
    preferencesService = new PreferencesService(createElectronPreferenceStore(), () =>
      app.getPreferredSystemLanguages()
    )
    registerPreferencesIpc(preferencesService)
  } catch (error) {
    console.error('Failed to initialize locale preferences', error)
  }

  // 对话解释使用 Main 解析的当前界面语言，并在每次请求开始时显式传给模型。
  const resolveOutputLanguage = (): SupportedLocale => {
    try {
      return preferencesService?.getLocale().resolvedLocale ?? 'zh-CN'
    } catch {
      return 'zh-CN'
    }
  }
  registerConversationIpc(
    new ConversationModule(conversationModel, conversationRepository, resolveOutputLanguage)
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  conversationRepository?.close()
  conversationRepository = undefined
})

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'https:'
  } catch {
    return false
  }
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
