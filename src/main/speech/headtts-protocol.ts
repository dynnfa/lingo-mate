import { z } from 'zod'
import { SPEECH_IDENTITY, SPEECH_LIMITS, speechSettingsSchema } from '../../shared/speech'

export const runtimeIdentitySchema = z.strictObject({
  headtts: z.literal(SPEECH_IDENTITY.headtts),
  transformers: z.literal(SPEECH_IDENTITY.transformers),
  dtype: z.literal('fp32'),
  device: z.literal('cpu'),
  revision: z.literal(SPEECH_IDENTITY.revision),
  alignment: z.literal(SPEECH_IDENTITY.alignment)
})
export const segmentSchema = z.strictObject({
  audio: z
    .instanceof(Uint8Array)
    .refine((v) => v.byteLength > 44 && v.byteLength <= SPEECH_LIMITS.audioBytes),
  words: z.array(z.string().max(SPEECH_LIMITS.segmentUnits)).max(SPEECH_LIMITS.words),
  wtimes: z.array(z.number().finite()).max(SPEECH_LIMITS.words),
  wdurations: z.array(z.number().finite()).max(SPEECH_LIMITS.words)
})
export const runtimeRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('init'), modelPath: z.string().min(1).max(4096) }),
  z.strictObject({
    type: z.literal('synthesize'),
    id: z.string().uuid(),
    text: z.string().min(1).max(SPEECH_LIMITS.segmentUnits),
    settings: speechSettingsSchema
  })
])
export const runtimeResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), identity: runtimeIdentitySchema }),
  z.strictObject({ type: z.literal('audio'), id: z.string().uuid(), segment: segmentSchema }),
  z.strictObject({ type: z.literal('token-limit'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('error') })
])
