// 错误码 → i18n key 的统一解析配方：领域映射 → 公共映射 → errors:unknown
// 三层回退。领域文件保持穷尽 Record（新增错误码在编译期暴露漏配站点），
// 公共条目收敛跨域重复的错误码（UNKNOWN_ERROR 等）。

export type ErrorMessages<TCode extends string> = Record<TCode, string>

// 跨域重复错误码的公共 key：领域 Record 经展开复用，资源只保留一份文案。
export const COMMON_ERROR_KEY_ENTRIES = {
  UNKNOWN_ERROR: 'errors:common.unknown',
  UNTRUSTED_SOURCE: 'errors:common.untrustedSource',
  INVALID_INPUT: 'errors:common.invalidInput',
  STORAGE_FAILED: 'errors:common.storageFailed'
} as const satisfies ErrorMessages<string>

// 工厂返回领域解析函数：先查领域映射，再回退公共映射，最终落到 errors:unknown。
// 领域映射的值类型 K 原样保留，调用方的 key 字面量联合与编译期检查不受影响。
export function createErrorKeyResolver(common: ErrorMessages<string>) {
  return <T extends string, K extends string>(
    domain: Record<T, K>,
    code: T | string | null | undefined
  ): K => {
    if (code !== null && code !== undefined) {
      const domainKey = (domain as Record<string, K | undefined>)[code]
      if (domainKey !== undefined) return domainKey
      const commonKey = (common as Record<string, K | undefined>)[code]
      if (commonKey !== undefined) return commonKey
    }
    return 'errors:unknown' as K
  }
}
