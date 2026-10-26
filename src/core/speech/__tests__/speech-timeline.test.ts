import { describe, expect, it } from 'vitest'
import { buildSpeechTimeline } from '../speech-timeline'

describe('HeadTTS original-text timeline', () => {
  it.each([
    { words: ['hello'], wtimes: [NaN], wdurations: [10] },
    { words: ['hello'], wtimes: [0], wdurations: [0] },
    { words: ['hello'], wtimes: [0], wdurations: [2000] },
    { words: ['different'], wtimes: [0], wdurations: [200] }
  ])('rejects invalid or unbound timing data', (timing) => {
    expect(() => buildSpeechTimeline('hello', timing, 1)).toThrow()
  })
  it('maps repeated subtitles cumulatively and retains punctuation gaps in the source', () => {
    expect(
      buildSpeechTimeline(
        '  Hello, hello! It’s 2026.',
        {
          words: ['  Hello, ', 'hello! ', 'It’s ', '2026.'],
          wtimes: [100, 500, 900, 1200],
          wdurations: [300, 300, 200, 400]
        },
        2
      )
    ).toEqual([
      { index: 0, text: 'Hello', charStart: 2, charEnd: 7, startSeconds: 0.1, endSeconds: 0.4 },
      { index: 1, text: 'hello', charStart: 9, charEnd: 14, startSeconds: 0.5, endSeconds: 0.8 },
      { index: 2, text: 'It’s', charStart: 16, charEnd: 20, startSeconds: 0.9, endSeconds: 1.1 },
      { index: 3, text: '2026', charStart: 21, charEnd: 25, startSeconds: 1.2, endSeconds: 1.6 }
    ])
  })
})
