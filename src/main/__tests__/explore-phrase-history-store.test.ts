import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPLORE_PHRASE_HISTORY_BATCH_LIMIT,
  type ExplorePhraseBatch
} from '../../shared/explore-phrase'
import { ExplorePhraseError } from '../../core/learning/explore-phrase/explore-phrase-error'
import type { CommitExplorePhraseBatchInput } from '../../core/learning/explore-phrase/explore-phrase-history-store'
import { normalizeExplorePhrase } from '../../core/learning/explore-phrase/normalize-explore-phrase'

// 用可覆写的 spy 包装真实 fs/promises：默认完全透传，个别用例注入一次失败。
const openSpy = vi.fn<(typeof import('node:fs/promises'))['open']>()
const renameSpy = vi.fn<(typeof import('node:fs/promises'))['rename']>()
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (...args: Parameters<typeof openSpy>) => openSpy(...args),
    rename: (...args: Parameters<typeof renameSpy>) => renameSpy(...args)
  }
})

const directories: string[] = []
afterEach(async () => {
  openSpy.mockReset()
  renameSpy.mockReset()
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

async function makeStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-mate-explore-'))
  directories.push(directory)
  return join(directory, 'explore-phrase-history.json')
}

async function importStore(): Promise<{
  JsonFileExplorePhraseHistoryStore: new (
    filePath: string
  ) => import('../explore-phrase-history-store').JsonFileExplorePhraseHistoryStore
}> {
  const { JsonFileExplorePhraseHistoryStore } = await import('../explore-phrase-history-store')
  return { JsonFileExplorePhraseHistoryStore }
}

let uuidCounter = 0
function uuid(): string {
  uuidCounter += 1
  const suffix = String(uuidCounter).padStart(6, '0')
  return `550e8400-e29b-41d4-a716-446655${suffix}`
}

function makeItems(
  prefix: string,
  overrides: Record<number, Record<string, string>> = {}
): CommitExplorePhraseBatchInput['items'] {
  return Array.from({ length: 10 }, (_unused, index) => {
    const phrase = overrides[index]?.phrase ?? `${prefix} phrase ${index}`
    return {
      phrase,
      normalizedPhrase: normalizeExplorePhrase(phrase),
      explanation: overrides[index]?.explanation ?? `释义 ${index}`,
      example: overrides[index]?.example ?? `An example with ${phrase} inside.`
    }
  })
}

function makeInput(
  prefix: string,
  overrides: Record<number, Record<string, string>> = {}
): CommitExplorePhraseBatchInput {
  return {
    executionId: uuid(),
    sessionId: uuid(),
    userMessageId: uuid(),
    committedAt: '2026-09-20T10:30:00.000Z',
    wordLanguage: 'en' as const,
    explanationLanguage: 'zh-CN' as const,
    items: makeItems(prefix, overrides)
  }
}

async function createStore(
  filePath: string
): Promise<import('../explore-phrase-history-store').JsonFileExplorePhraseHistoryStore> {
  const { JsonFileExplorePhraseHistoryStore } = await importStore()
  return new JsonFileExplorePhraseHistoryStore(filePath)
}

describe('JsonFileExplorePhraseHistoryStore', () => {
  beforeEach(() => {
    openSpy.mockImplementation((...args) =>
      (vi.importActual('node:fs/promises') as Promise<typeof import('node:fs/promises')>).then(
        (actual) => actual.open(...(args as Parameters<typeof actual.open>))
      )
    )
    renameSpy.mockImplementation((...args) =>
      (vi.importActual('node:fs/promises') as Promise<typeof import('node:fs/promises')>).then(
        (actual) => actual.rename(...(args as Parameters<typeof actual.rename>))
      )
    )
  })

  it('treats a missing file as first use and commits atomically', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    expect(await store.read()).toEqual({ schemaVersion: 1, batches: [] })

    const input = makeInput('batch')
    const batch = await store.commit(input, { base: { schemaVersion: 1, batches: [] } })
    expect(batch.executionId).toBe(input.executionId)

    const document = await store.read()
    expect(document.batches).toHaveLength(1)
    expect(document.batches[0]).toEqual(batch)
    // 写入是格式化 JSON，不手工拼接。
    const raw = await readFile(filePath, 'utf8')
    expect(raw).toBe(JSON.stringify(document, null, 2))
  })

  it('round-trips special characters without mangling', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const input = makeInput('special', {
      0: {
        phrase: 'a | b',
        explanation: '管道符 \\ 反引号 ` <b>加粗</b> & "引号"',
        example: 'She said a | b \\ `loudly` <i>&amp;</i>.'
      },
      1: {
        phrase: '全角 ＡＢＣ　空格',
        explanation: 'Unicode 变体',
        example: 'He wrote 全角 ＡＢＣ　空格 on the board.'
      }
    })
    await store.commit(input, { base: { schemaVersion: 1, batches: [] } })
    const document = await store.read()
    expect(document.batches[0].items[0].phrase).toBe('a | b')
    expect(document.batches[0].items[1].phrase).toContain('全角')
  })

  it('rejects empty, corrupt, unknown-version and unreadable files without overwriting', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)

    await writeFile(filePath, '', 'utf8')
    await expect(store.read()).rejects.toMatchObject({ code: 'HISTORY_UNREADABLE' })

    await writeFile(filePath, '{ not json', 'utf8')
    await expect(store.read()).rejects.toMatchObject({ code: 'HISTORY_UNREADABLE' })
    expect(await readFile(filePath, 'utf8')).toBe('{ not json')

    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, batches: [] }), 'utf8')
    await expect(store.read()).rejects.toMatchObject({ code: 'HISTORY_UNREADABLE' })

    // readFile(目录) 抛 EISDIR：不是 ENOENT，按不可读处理。
    const directory = await mkdtemp(join(tmpdir(), 'lingo-mate-explore-'))
    directories.push(directory)
    const directoryStore = await createStore(join(directory, 'history.json'))
    await import('node:fs/promises').then((fs) => fs.mkdir(join(directory, 'history.json')))
    await expect(directoryStore.read()).rejects.toMatchObject({ code: 'HISTORY_UNREADABLE' })
  })

  it('validates history invariants: identities, cross-batch dedup and normalized keys', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const base = await store.read()

    // normalizedPhrase 与重新计算不一致。
    const mismatched = makeInput('mismatch')
    mismatched.items[0].normalizedPhrase = 'something else'
    await expect(store.commit(mismatched, { base })).rejects.toMatchObject({
      code: 'STORAGE_FAILED'
    })

    // 与现有批次短语重复。
    const first = await store.commit(makeInput('first'), { base })
    const updated = await store.read()
    const duplicate = makeInput('second')
    duplicate.items[0] = { ...first.items[0] }
    await expect(store.commit(duplicate, { base: updated })).rejects.toMatchObject({
      code: 'STORAGE_FAILED'
    })

    // 批次不足 10 项。
    const short = makeInput('short')
    short.items = short.items.slice(0, 9)
    await expect(store.commit(short, { base: updated })).rejects.toMatchObject({
      code: 'STORAGE_FAILED'
    })
    expect((await store.read()).batches).toHaveLength(1)
  })

  it('returns the committed batch for repeated executionId or userMessageId', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const input = makeInput('idempotent')
    const batch = await store.commit(input, { base: await store.read() })
    const updated = await store.read()

    const sameExecution = await store.commit(input, { base: updated })
    expect(sameExecution).toEqual(batch)

    const otherExecution = { ...input, executionId: uuid() }
    const sameUserMessage = await store.commit(otherExecution, { base: updated })
    expect(sameUserMessage).toEqual(batch)
    expect((await store.read()).batches).toHaveLength(1)

    expect(await store.findBatchByUserMessage(input.userMessageId)).toEqual(batch)
    expect(await store.findBatchByUserMessage(uuid())).toBeUndefined()
  })

  it('keeps only the last seven batches in submission order', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const committed: ExplorePhraseBatch[] = []
    for (let index = 0; index < 8; index += 1) {
      const input = makeInput(`window${index}`)
      committed.push(await store.commit(input, { base: await store.read() }))
    }
    const document = await store.read()
    expect(document.batches).toHaveLength(EXPLORE_PHRASE_HISTORY_BATCH_LIMIT)
    expect(document.batches.map((batch) => batch.executionId)).toEqual(
      committed.slice(1).map((batch) => batch.executionId)
    )
    // 第 1 批已淘汰：同短语可再次提交。
    const reused = makeInput('reused')
    reused.items = makeItems('window0')
    const base = await store.read()
    const batch = await store.commit(reused, { base })
    expect(batch.items[0].phrase).toBe('window0 phrase 0')
  })

  it('aborts the commit when the file changed externally since the read snapshot', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const first = await store.commit(makeInput('external'), { base: await store.read() })
    const stale = { schemaVersion: 1 as const, batches: [first] }
    // 外部提交了另一批，生成期间的快照已过期。
    await store.commit(makeInput('newer'), { base: await store.read() })

    const before = await readFile(filePath, 'utf8')
    await expect(store.commit(makeInput('stale'), { base: stale })).rejects.toMatchObject({
      code: 'HISTORY_MODIFIED'
    })
    expect(await readFile(filePath, 'utf8')).toBe(before)
  })

  it('refuses to evict a protected batch and keeps the file unchanged', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const first = await store.commit(makeInput('protected'), { base: await store.read() })
    for (let index = 1; index < 7; index += 1) {
      await store.commit(makeInput(`filler${index}`), { base: await store.read() })
    }
    const before = await readFile(filePath, 'utf8')
    await expect(
      store.commit(makeInput('overflow'), {
        base: await store.read(),
        isProtected: (batch) => batch.executionId === first.executionId
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_PENDING' })
    expect(await readFile(filePath, 'utf8')).toBe(before)
  })

  it('keeps the old file and cleans the temp file when writing or renaming fails', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    await store.commit(makeInput('initial'), { base: await store.read() })
    const before = await readFile(filePath, 'utf8')
    const directory = filePath.slice(0, filePath.lastIndexOf('/'))

    openSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    await expect(
      store.commit(makeInput('wfail'), { base: await store.read() })
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    expect(await readFile(filePath, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([])

    renameSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('rename failed'), { code: 'EPERM' })
    })
    await expect(
      store.commit(makeInput('rfail'), { base: await store.read() })
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    expect(await readFile(filePath, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('removes leftover temp files at startup', async () => {
    const filePath = await makeStorePath()
    const store = await createStore(filePath)
    const directory = filePath.slice(0, filePath.lastIndexOf('/'))
    const tempOne = `${filePath}.tmp-aaaa`
    const tempTwo = `${filePath}.tmp-bbbb`
    const unrelated = join(directory, 'other.json.tmp-x')
    await writeFile(tempOne, 'partial', 'utf8')
    await writeFile(tempTwo, 'partial', 'utf8')
    await writeFile(unrelated, 'keep', 'utf8')

    await store.cleanupLeftoverTempFiles()
    const names = await readdir(directory)
    expect(names).not.toContain('explore-phrase-history.json.tmp-aaaa')
    expect(names).not.toContain('explore-phrase-history.json.tmp-bbbb')
    expect(names).toContain('other.json.tmp-x')
  })
})

describe('ExplorePhraseError', () => {
  it('carries a stable code and keeps the cause', () => {
    const cause = new Error('boom')
    const error = new ExplorePhraseError('STORAGE_FAILED', { cause })
    expect(error.code).toBe('STORAGE_FAILED')
    expect(error.cause).toBe(cause)
  })
})
