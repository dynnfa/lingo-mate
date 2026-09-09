import { SynonymError } from './parse-synonym-input'

const safeCodes = new Set([
  'SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_CORRUPT',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_NOTNULL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ABORT_ERR'
])

// Preserve the cause chain for internal diagnosis without logging messages, stacks,
// request/response bodies or arbitrary provider codes, which can contain user data.
export function reportSynonymFailure(cause: unknown): void {
  const chain: Array<{ type: string; code?: string; status?: number }> = []
  const seen = new Set<unknown>()
  while (cause instanceof Error && !seen.has(cause) && chain.length < 8) {
    seen.add(cause)
    const code = 'code' in cause ? cause.code : undefined
    const status = 'status' in cause ? cause.status : undefined
    chain.push({
      type: cause instanceof SynonymError ? 'SynonymError' : 'Error',
      ...(cause instanceof SynonymError
        ? { code: cause.code }
        : typeof code === 'string' && safeCodes.has(code)
          ? { code }
          : {}),
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
        ? { status }
        : {})
    })
    cause = cause.cause
  }
  console.error('[synonym] WORD_FAILED', chain)
}
