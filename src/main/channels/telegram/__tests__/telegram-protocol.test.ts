import { expect, it } from 'vitest'
import { mapUpdate, parseCursor, makeCursor } from '../telegram-protocol'
import { encodeTelegramText } from '../telegram-encoding'
const update = (text = 'hello'): unknown => ({
  update_id: 42,
  message: {
    message_id: 7,
    date: 1800000000,
    from: { id: 9007199254740000, is_bot: false, first_name: 'Alice' },
    chat: { id: 9007199254740000, type: 'private' },
    text
  }
})
it('maps safe IDs, source time and original text, normalizing only this bot command token', () => {
  expect(mapUpdate(update('/sentence@Lingo_bot  原文 '), 'lingo_bot')).toMatchObject({
    event: {
      text: '/sentence  原文 ',
      externalActorId: '9007199254740000',
      externalEventId: '42',
      occurredAt: 1800000000000,
      scope: 'private'
    }
  })
  expect(mapUpdate(update('  hello *🙂* '), 'lingo_bot')).toMatchObject({
    event: { text: '  hello *🙂* ' }
  })
  expect(mapUpdate(update('/help@other_bot'), 'lingo_bot')).toMatchObject({
    rejected: { kind: 'other-bot' }
  })
})
it('persists rejection for empty, overlong, malformed or unsupported updates with a reliable ID', () => {
  for (const raw of [
    update(''),
    update('a'.repeat(4001)),
    { update_id: 42 },
    { update_id: 42, message: { from: { id: Number.MAX_SAFE_INTEGER + 1 } } }
  ]) {
    expect(mapUpdate(raw, 'lingo_bot')).toMatchObject({
      rejected: { externalEventId: '42', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }
    })
  }
  expect(() => mapUpdate({ update_id: Number.MAX_SAFE_INTEGER }, 'lingo_bot')).toThrow()
  expect(() => mapUpdate({}, 'lingo_bot')).toThrow()
  expect(mapUpdate(update('a'.repeat(4000)), 'lingo_bot')).toHaveProperty('event')
})
it('does not downgrade group/topic, bots, business or edited messages to ordinary private text', () => {
  const base = update() as { update_id: number; message: Record<string, unknown> }
  expect(
    mapUpdate({ ...base, message: { ...base.message, message_thread_id: 8 } }, 'lingo_bot')
  ).toMatchObject({ event: { scope: 'topic', externalThreadId: '8' } })
  expect(mapUpdate({ update_id: 42, edited_message: base.message }, 'lingo_bot')).toMatchObject({
    event: { type: 'unsupported', kind: 'edit' }
  })
  expect(
    mapUpdate(
      { ...base, message: { ...base.message, business_connection_id: 'business' } },
      'lingo_bot'
    )
  ).toHaveProperty('rejected')
})
it('binds versioned cursors to a verified bot and never resets invalid cursors', () => {
  expect(parseCursor(makeCursor('123', 43), '123')).toBe(43)
  expect(parseCursor(undefined, '123')).toBeUndefined()
  for (const cursor of ['garbage', makeCursor('123', 43), '{"v":1,"botId":"456","offset":-1}'])
    expect(() => parseCursor(cursor, '456')).toThrow()
})
it.each([
  'a'.repeat(4001),
  '🙂'.repeat(3000),
  '中'.repeat(8000),
  ('*a* _b_\n' + 'e\u0301 ').repeat(900)
])('encodes deterministically without loss or broken surrogate pairs', (text) => {
  const parts = encodeTelegramText(text)
  expect(parts.map((p) => p.text).join('')).toBe(text)
  expect(
    parts.every((p) => p.format === 'plain' && p.text.length <= 4000 && p.text.isWellFormed())
  ).toBe(true)
  expect(encodeTelegramText(text)).toEqual(parts)
})
it('accepts the safe offset boundary, rejects unsafe routing IDs and bounds single updates', () => {
  expect(parseCursor(makeCursor('123', Number.MAX_SAFE_INTEGER), '123')).toBe(
    Number.MAX_SAFE_INTEGER
  )
  const base = update() as { update_id: number; message: Record<string, unknown> }
  expect(mapUpdate({ ...base, update_id: 0 }, 'lingo_bot')).toHaveProperty('event')
  expect(mapUpdate({ ...base, extra: 'a'.repeat(256 * 1024) }, 'lingo_bot')).toMatchObject({
    rejected: { kind: 'oversized' }
  })
  expect(
    mapUpdate(
      {
        ...base,
        message: { ...base.message, from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } }
      },
      'lingo_bot'
    )
  ).toHaveProperty('rejected')
})
