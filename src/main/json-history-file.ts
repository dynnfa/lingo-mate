import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

// 两种探索技能（explore-phrase / explore-vocabulary）JSON 历史文件共享的物理
// 读写机制：读取（文件缺失视为首次使用，其余按不可读失败）、原子替换
//（同目录唯一临时文件 → flush → rename → 目录同步 → 核实）与遗留临时文件
// 清理。文档结构校验、领域错误类型与提交语义由各技能注入；本层不持有业务
// schema，也不通过放宽校验换取复用。

export interface JsonHistoryFileMechanics<E> {
  cancelled: () => E
  storageFailed: (cause?: unknown) => E
  commitUncertain: (cause?: unknown) => E
}

// 读取历史文件：parse 负责空文件、JSON 结构与业务不变量校验（抛出领域
// unreadable 错误）；只有 ENOENT 走空文档路径。
export async function readJsonHistoryFile<D, E>(
  filePath: string,
  emptyDocument: () => D,
  parse: (raw: string) => D,
  toUnreadable: (cause: unknown) => E
): Promise<D> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在视为首次使用。
      return emptyDocument()
    }
    throw toUnreadable(error)
  }
  return parse(raw)
}

// 内部取消哨兵：区分“提交前取消”与写入/替换失败，不依赖具体错误类型。
const CANCELLED_BEFORE_WRITE = Symbol('json-history-cancelled-before-write')

export interface WriteJsonHistoryFileOptions<E> {
  filePath: string
  document: unknown
  signal?: AbortSignal
  mechanics: JsonHistoryFileMechanics<E>
  // 替换后目录同步失败时重读目标文件核实：返回 true 表示批次确已落盘。
  verifyCommitted: () => Promise<boolean>
}

// 原子替换：完整 JSON 写入同目录唯一临时文件，flush 后 rename；替换前最后
// 检查取消；替换后的同步或核实失败标记为提交不确定，不盲目重写、也不声称
// 已回滚。
export async function writeJsonHistoryFileAtomically<E>(
  options: WriteJsonHistoryFileOptions<E>
): Promise<void> {
  const { filePath, document, signal, mechanics, verifyCommitted } = options
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  let handle: FileHandle | undefined
  try {
    handle = await open(tempPath, 'w')
    await handle.writeFile(JSON.stringify(document, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    if (signal?.aborted) throw CANCELLED_BEFORE_WRITE
    await rename(tempPath, filePath)
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined)
    // 写入或替换失败：保留旧文件，清理临时文件。
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (cause === CANCELLED_BEFORE_WRITE) throw mechanics.cancelled()
    throw mechanics.storageFailed(cause)
  }
  // 替换后的目录同步失败属于提交状态不确定：核实后决定返回还是失败。
  try {
    await syncDirectory(dirname(filePath))
  } catch (cause) {
    try {
      if (await verifyCommitted()) return
    } catch (verificationError) {
      throw mechanics.commitUncertain(verificationError)
    }
    throw mechanics.commitUncertain(cause)
  }
}

// 启动时清理本文件遗留的临时文件：临时文件只是写入过程产物，不当作已提交
// 历史；只匹配该文件自己的 `<basename>.tmp-` 前缀。
export async function cleanupJsonHistoryTempFiles(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  const prefix = `${basename(filePath)}.tmp-`
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map((name) => rm(join(directory, name), { force: true }).catch(() => undefined))
  )
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } finally {
    await handle?.close()
  }
}
