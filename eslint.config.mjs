import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // IPC 信任边界：Main 生产代码只能经 ipc-guard 的 registerTrustedHandler
    // 注册 Renderer 请求入口；ipc-guard 本身与使用 mock 的 IPC 测试除外。
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/ipc-guard.ts', 'src/main/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              importNames: ['ipcMain'],
              message:
                'Main 生产代码禁止直接导入 ipcMain；请使用 src/main/ipc-guard.ts 的 registerTrustedHandler 注册 Renderer 请求入口。'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name='ipcMain']",
          message:
            'Main 生产代码禁止访问原始 ipcMain（含 handle/handleOnce/on/once 等别名或命名空间形式）；请使用 registerTrustedHandler。'
        }
      ]
    }
  },
  eslintConfigPrettier
)
