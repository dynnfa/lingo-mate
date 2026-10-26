import type { WebContents } from 'electron'
import { z } from 'zod'
import { noInputSchema, type RegisterTrustedHandler } from './ipc-guard'
import type { TtsRepository } from '../core/speech/tts-repository'
import type { SpeechHost } from './speech/speech-host'
import { SpeechError } from '../core/speech/speech-synthesizer'
import {
  SPEECH_CHANNELS as C,
  speechActionResultSchema,
  speechFailureSchema,
  conversationAudioInputSchema,
  speechInputSchema,
  speechRequestSchema,
  speechRuntimeStatusSchema,
  speechSettingsResultSchema,
  speechSettingsSchema,
  speechStatusResultSchema,
  speechSynthesisResultSchema
} from '../shared/speech'

export function registerSpeechIpc(
  host: SpeechHost,
  register: RegisterTrustedHandler,
  repository: Pick<TtsRepository, 'loadConversationAudio'>
): () => void {
  const active = new Map<WebContents, { requestId: string; controller: AbortController }>()
  const senders = new Map<WebContents, () => void>()
  const usedIds = new Set<string>()
  let installation: { owner: WebContents; controller: AbortController } | undefined
  const watch = (sender: WebContents): void => {
    if (senders.has(sender)) return
    const destroyed = (): void => {
      active.get(sender)?.controller.abort()
      active.delete(sender)
      if (installation?.owner === sender) installation.controller.abort()
      senders.delete(sender)
    }
    senders.set(sender, destroyed)
    sender.once('destroyed', destroyed)
  }
  const unsubscribe = host.subscribe((raw) => {
    const parsed = speechRuntimeStatusSchema.safeParse(raw)
    if (!parsed.success) return
    for (const sender of senders.keys())
      if (!sender.isDestroyed()) sender.send(C.status, parsed.data)
  })
  const common = {
    invalidInputError: () => ({ code: 'INVALID_INPUT' as const }),
    mapError: (error: unknown): z.infer<typeof speechFailureSchema>['error'] => ({
      code: error instanceof SpeechError ? error.code : 'RUNTIME_FAILED'
    }),
    fallbackError: { code: 'RUNTIME_FAILED' as const }
  }
  const removes = [
    register({
      ...common,
      channel: C.loadConversationAudio,
      inputSchema: conversationAudioInputSchema,
      resultSchema: speechSynthesisResultSchema,
      handler: async (input) => {
        return { status: 'ok' as const, result: await repository.loadConversationAudio(input) }
      }
    }),
    register({
      ...common,
      channel: C.synthesize,
      inputSchema: speechInputSchema,
      resultSchema: speechSynthesisResultSchema,
      handler: async (input, { sender }) => {
        watch(sender)
        if (usedIds.has(input.requestId)) throw new SpeechError('INVALID_INPUT')
        if (usedIds.size >= 256) usedIds.delete(usedIds.values().next().value!)
        usedIds.add(input.requestId)
        active.get(sender)?.controller.abort()
        const request = { requestId: input.requestId, controller: new AbortController() }
        active.set(sender, request)
        try {
          const result = await host.synthesize(input, request.controller.signal)
          if (
            request.controller.signal.aborted ||
            sender.isDestroyed() ||
            active.get(sender) !== request
          )
            throw new SpeechError('CANCELLED')
          return { status: 'ok' as const, result }
        } finally {
          if (active.get(sender) === request) active.delete(sender)
        }
      }
    }),
    register({
      ...common,
      channel: C.cancel,
      inputSchema: speechRequestSchema,
      resultSchema: speechActionResultSchema,
      handler: ({ requestId }, { sender }) => {
        const request = active.get(sender)
        if (!request || request.requestId !== requestId) throw new SpeechError('NOT_OWNER')
        request.controller.abort()
        return { status: 'ok' as const }
      }
    }),
    register({
      ...common,
      channel: C.getSettings,
      inputSchema: noInputSchema,
      resultSchema: speechSettingsResultSchema,
      handler: async (_, { sender }) => {
        watch(sender)
        return { status: 'ok' as const, settings: await host.getSettings() }
      }
    }),
    register({
      ...common,
      channel: C.updateSettings,
      inputSchema: speechSettingsSchema,
      resultSchema: speechSettingsResultSchema,
      handler: async (input) => ({
        status: 'ok' as const,
        settings: await host.updateSettings(input)
      })
    }),
    register({
      ...common,
      channel: C.getRuntimeStatus,
      inputSchema: noInputSchema,
      resultSchema: speechStatusResultSchema,
      handler: async (_, { sender }) => {
        watch(sender)
        return { status: 'ok' as const, runtime: await host.getRuntimeStatus() }
      }
    }),
    register({
      ...common,
      channel: C.installResources,
      inputSchema: noInputSchema,
      resultSchema: speechActionResultSchema,
      handler: async (_, { sender }) => {
        watch(sender)
        if (installation) throw new SpeechError('BUSY')
        const current = { owner: sender, controller: new AbortController() }
        installation = current
        try {
          await host.installResources(current.controller.signal)
          return { status: 'ok' as const }
        } finally {
          if (installation === current) installation = undefined
        }
      }
    }),
    register({
      ...common,
      channel: C.cancelInstall,
      inputSchema: noInputSchema,
      resultSchema: speechActionResultSchema,
      handler: (_, { sender }) => {
        if (installation?.owner !== sender) throw new SpeechError('NOT_OWNER')
        installation.controller.abort()
        return { status: 'ok' as const }
      }
    })
  ]
  return () => {
    for (const request of active.values()) request.controller.abort()
    active.clear()
    installation?.controller.abort()
    for (const [sender, listener] of senders) sender.removeListener('destroyed', listener)
    senders.clear()
    removes.forEach((remove) => remove())
    unsubscribe()
    host.dispose()
  }
}
