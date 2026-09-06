import type { ModelsErrorCode } from '../../../shared/models'

type ModelsErrorKey =
  | 'errors:models.untrustedSource'
  | 'errors:models.readFailed'
  | 'errors:models.writeFailed'
  | 'errors:models.clearFailed'
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

// 清除配置失败时写入错误换成清除语境文案，其余码保持原语义。
export function modelsClearErrorKey(code: ModelsErrorCode): ModelsErrorKey {
  return code === 'MODELS_WRITE_FAILED' ? 'errors:models.clearFailed' : modelsErrorKey(code)
}
