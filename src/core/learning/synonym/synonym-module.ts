import type { SynonymBatch } from '../../../shared/synonym'
import type { ConversationSkillRunInput } from '../../conversation/conversation-skill'
import type { SynonymRepository } from './synonym-repository'
import type { SynonymAnalyzer } from './synonym-analyzer'
import type { SynonymAgentRuntime } from '../../agent/agent-runtime'
import { SynonymHost } from './synonym-host'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../../error-diagnostics'

export class SynonymModule {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly repository: SynonymRepository,
    private readonly createAnalyzer: (timeoutMs: number) => SynonymAnalyzer,
    private readonly runtime: SynonymAgentRuntime,
    private readonly wordMs = 60_000,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {}

  async addBatch(input: ConversationSkillRunInput): Promise<SynonymBatch> {
    const host = new SynonymHost(
      this.repository,
      this.createAnalyzer,
      input,
      this.wordMs,
      this.diagnostics
    )
    let started = false
    let cancelled = false
    let onAbort: () => void = () => {}
    const interrupted = new Promise<SynonymBatch>((resolve, reject) => {
      onAbort = () => {
        if (started) return
        cancelled = true
        try {
          resolve(host.persist(true))
        } catch (cause) {
          reject(cause)
        }
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) onAbort()
    })
    const task = this.queue.then(async () => {
      if (cancelled) return interrupted
      started = true
      try {
        await input.onPhase('analyzing')
        await this.runtime.runSynonym(
          { outputLanguage: input.explanationLanguage, targetLanguage: 'en', signal: input.signal },
          host
        )
        input.signal.throwIfAborted()
        return host.persist(true)
      } catch (cause) {
        if (input.signal.aborted) return host.persist(true)
        throw cause
      } finally {
        host.close()
      }
    })
    this.queue = task.catch(() => {})
    try {
      return await Promise.race([task, interrupted])
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
  }
}
