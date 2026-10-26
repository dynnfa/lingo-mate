import { z } from 'zod'

export const SPEECH_LIMITS = {
  textUnits: 2000,
  segmentUnits: 350,
  segments: 20,
  tokens: 511,
  seconds: 120,
  audioBytes: 8 * 1024 * 1024,
  words: 2000,
  totalMs: 180_000,
  loadMs: 120_000,
  segmentMs: 60_000,
  queue: 4
} as const
export const SPEECH_IDENTITY = {
  headtts: '1.3.0',
  transformers: '4.0.0',
  dtype: 'fp32',
  device: 'cpu',
  revision: 'dd4401a9add81ac692d20e240d22ec9dda82cc29',
  alignment: 'headtts-decoder-frames-v1'
} as const
export const SPEECH_VOICES = ['af_bella', 'am_michael'] as const
export const speechSettingsSchema = z.strictObject({
  voice: z.enum(SPEECH_VOICES),
  speed: z.number().min(0.75).max(1.5)
})
export type SpeechSettings = z.infer<typeof speechSettingsSchema>
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = { voice: 'af_bella', speed: 1 }
export const speechInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  text: z
    .string()
    .min(1)
    .max(SPEECH_LIMITS.textUnits)
    .refine(
      (text) =>
        /[A-Za-z0-9]/.test(text) &&
        !/[<>`]/u.test(text) &&
        [...text].every((c) => c.charCodeAt(0) >= 32 || c === '\t' || c === '\n' || c === '\r')
    ),
  language: z.literal('en')
})
export type SpeechInput = z.infer<typeof speechInputSchema>
export const speechRequestSchema = z.strictObject({ requestId: z.string().uuid() })
export const speechWordSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(SPEECH_LIMITS.segmentUnits),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().positive(),
  startSeconds: z.number().nonnegative().max(SPEECH_LIMITS.seconds),
  endSeconds: z.number().positive().max(SPEECH_LIMITS.seconds)
})
export type SpeechWord = z.infer<typeof speechWordSchema>
export const speechAudioSchema = z
  .strictObject({
    requestId: z.string().uuid(),
    text: speechInputSchema.shape.text,
    language: z.literal('en'),
    settings: speechSettingsSchema,
    identity: z.literal(SPEECH_IDENTITY.revision),
    audio: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 44 && bytes.byteLength <= SPEECH_LIMITS.audioBytes),
    durationSeconds: z.number().positive().max(SPEECH_LIMITS.seconds),
    words: z.array(speechWordSchema).min(1).max(SPEECH_LIMITS.words)
  })
  .superRefine((audio, context) => {
    let charEnd = 0
    let timeEnd = 0
    for (const [index, word] of audio.words.entries()) {
      if (
        word.index !== index ||
        word.charStart < charEnd ||
        word.charEnd <= word.charStart ||
        word.charEnd > audio.text.length ||
        audio.text.slice(word.charStart, word.charEnd) !== word.text ||
        word.startSeconds < timeEnd ||
        word.endSeconds <= word.startSeconds ||
        word.endSeconds > audio.durationSeconds
      ) {
        context.addIssue({
          code: 'custom',
          path: ['words', index],
          message: 'Invalid speech alignment'
        })
      }
      charEnd = word.charEnd
      timeEnd = word.endSeconds
    }
  })
export type SpeechAudio = z.infer<typeof speechAudioSchema>
export const speechErrorCodeSchema = z.enum([
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'NOT_INSTALLED',
  'INSTALL_FAILED',
  'BUSY',
  'CANCELLED',
  'TIMEOUT',
  'RUNTIME_FAILED',
  'INVALID_AUDIO',
  'INVALID_TIMELINE',
  'TEXT_LIMIT',
  'TOKEN_LIMIT',
  'NOT_OWNER',
  'SETTINGS_FAILED',
  'CLOCK_FAILED'
])
export type SpeechErrorCode = z.infer<typeof speechErrorCodeSchema>
export const speechFailureSchema = z.strictObject({
  status: z.literal('error'),
  error: z.strictObject({ code: speechErrorCodeSchema })
})
export const speechSynthesisResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), result: speechAudioSchema }),
  speechFailureSchema
])
export const speechSettingsResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), settings: speechSettingsSchema }),
  speechFailureSchema
])
export const speechActionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  speechFailureSchema
])
export const speechRuntimeStatusSchema = z.strictObject({
  phase: z.enum(['not-installed', 'installing', 'unloaded', 'loading', 'ready', 'failed']),
  progress: z.number().min(0).max(1),
  error: speechErrorCodeSchema.optional()
})
export type SpeechRuntimeStatus = z.infer<typeof speechRuntimeStatusSchema>
export const speechStatusResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), runtime: speechRuntimeStatusSchema }),
  speechFailureSchema
])
export const SPEECH_CHANNELS = {
  synthesize: 'speech:synthesize',
  cancel: 'speech:cancel',
  getSettings: 'speech:getSettings',
  updateSettings: 'speech:updateSettings',
  getRuntimeStatus: 'speech:getRuntimeStatus',
  installResources: 'speech:installResources',
  cancelInstall: 'speech:cancelInstall',
  status: 'speech:status'
} as const
export interface SpeechApi {
  synthesize(input: SpeechInput): Promise<z.infer<typeof speechSynthesisResultSchema>>
  cancel(
    input: z.infer<typeof speechRequestSchema>
  ): Promise<z.infer<typeof speechActionResultSchema>>
  getSettings(): Promise<z.infer<typeof speechSettingsResultSchema>>
  updateSettings(input: SpeechSettings): Promise<z.infer<typeof speechSettingsResultSchema>>
  getRuntimeStatus(): Promise<z.infer<typeof speechStatusResultSchema>>
  installResources(): Promise<z.infer<typeof speechActionResultSchema>>
  cancelInstall(): Promise<z.infer<typeof speechActionResultSchema>>
  onStatus(listener: (status: SpeechRuntimeStatus) => void): () => void
}
