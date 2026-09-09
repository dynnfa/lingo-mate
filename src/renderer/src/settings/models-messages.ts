import type { ModelsErrorCode } from '../../../shared/models'
import type { ModelsTestOutcome } from './useModelsSettings'

type ModelsErrorKey =
  | 'errors:models.untrustedSource'
  | 'errors:models.invalidConfigId'
  | 'errors:models.configNotFound'
  | 'errors:models.readFailed'
  | 'errors:models.writeFailed'
  | 'errors:models.deleteFailed'
  | 'errors:models.setActiveFailed'
  | 'errors:models.invalidBaseUrl'
  | 'errors:models.invalidModelId'
  | 'errors:models.invalidApiKey'
  | 'errors:models.crossOriginCredential'
  | 'errors:models.credentialStorageUnavailable'
  | 'errors:models.credentialDecryptFailed'
  | 'errors:models.testInProgress'
  | 'errors:models.testCancelled'
  | 'errors:models.testTimeout'
  | 'errors:models.testAuthFailed'
  | 'errors:models.testModelUnavailable'
  | 'errors:models.testNetworkError'
  | 'errors:models.testUnsupportedResponse'
  | 'errors:models.unknown'

// 穷尽的显式映射，不使用任意字符串断言绕过 key 校验。
const MODELS_ERROR_KEYS: Record<ModelsErrorCode, ModelsErrorKey> = {
  UNTRUSTED_SOURCE: 'errors:models.untrustedSource',
  INVALID_CONFIG_ID: 'errors:models.invalidConfigId',
  CONFIG_NOT_FOUND: 'errors:models.configNotFound',
  INVALID_BASE_URL: 'errors:models.invalidBaseUrl',
  INVALID_MODEL_ID: 'errors:models.invalidModelId',
  INVALID_API_KEY: 'errors:models.invalidApiKey',
  CROSS_ORIGIN_CREDENTIAL: 'errors:models.crossOriginCredential',
  MODELS_READ_FAILED: 'errors:models.readFailed',
  MODELS_WRITE_FAILED: 'errors:models.writeFailed',
  CREDENTIAL_STORAGE_UNAVAILABLE: 'errors:models.credentialStorageUnavailable',
  CREDENTIAL_DECRYPT_FAILED: 'errors:models.credentialDecryptFailed',
  TEST_IN_PROGRESS: 'errors:models.testInProgress',
  TEST_CANCELLED: 'errors:models.testCancelled',
  TEST_TIMEOUT: 'errors:models.testTimeout',
  TEST_AUTH_FAILED: 'errors:models.testAuthFailed',
  TEST_MODEL_UNAVAILABLE: 'errors:models.testModelUnavailable',
  TEST_NETWORK_ERROR: 'errors:models.testNetworkError',
  TEST_UNSUPPORTED_RESPONSE: 'errors:models.testUnsupportedResponse',
  UNKNOWN_ERROR: 'errors:models.unknown'
}

export function modelsErrorKey(code: ModelsErrorCode): ModelsErrorKey {
  return MODELS_ERROR_KEYS[code]
}

// 删除失败时写入错误换成删除语境文案，其余码保持原语义。
export function modelsDeleteErrorKey(code: ModelsErrorCode): ModelsErrorKey {
  return code === 'MODELS_WRITE_FAILED' ? 'errors:models.deleteFailed' : modelsErrorKey(code)
}

// 保存当前模型选择失败使用切换语境文案，其余码保持原语义。
export function modelsSetActiveErrorKey(code: ModelsErrorCode): ModelsErrorKey {
  return code === 'MODELS_WRITE_FAILED' ? 'errors:models.setActiveFailed' : modelsErrorKey(code)
}

// 测试状态文案：行测试弹窗与草稿表单共用同一映射；idle 未开始，无文案。
type ModelsTestOutcomeKey =
  | 'common:settings.models.testRunning'
  | 'common:settings.models.testSucceeded'
  | 'common:settings.models.testStateCancelled'
  | ModelsErrorKey

export function modelsTestOutcomeKey(outcome: ModelsTestOutcome): ModelsTestOutcomeKey | undefined {
  if (outcome.status === 'running') return 'common:settings.models.testRunning'
  if (outcome.status === 'succeeded') return 'common:settings.models.testSucceeded'
  if (outcome.status === 'cancelled') return 'common:settings.models.testStateCancelled'
  if (outcome.status === 'failed') return modelsErrorKey(outcome.code)
  return undefined
}
