import { describe, expect, it } from 'vitest'
import { AudioPlayer, type SpeechAudioDevice } from '../audio-player'

function device(): SpeechAudioDevice & {
  nowMs: number
  outputTime: number
  state: AudioContextState
  rendered: () => void
} {
  return {
    nowMs: 1000,
    outputTime: 5,
    state: 'running',
    rendered: () => {},
    unlock: async () => {},
    currentTime: () => 5,
    now() {
      return this.nowMs
    },
    getState() {
      return this.state
    },
    getOutputTimestamp() {
      return { contextTime: this.outputTime, performanceTime: this.nowMs }
    },
    async decode() {
      return {
        durationSeconds: 2,
        start: (_at, _offset, ended) => {
          this.rendered = ended
          return { stop: () => undefined }
        }
      }
    },
    close: async () => {}
  }
}
describe('audio output clock', () => {
  it('propagates a device unlock failure when playback has not been superseded', async () => {
    const hardware = device()
    const error = new Error('Audio device unavailable')
    hardware.unlock = async () => {
      throw error
    }
    const player = new AudioPlayer(hardware)
    await player.load(new Uint8Array(1), 2)
    await expect(player.play()).rejects.toBe(error)
    expect(player.read().active).toBe(false)
  })

  it('waits for device output and keeps the tail after the render callback', async () => {
    const hardware = device()
    const player = new AudioPlayer(hardware)
    await player.load(new Uint8Array(1), 2)
    await player.play()
    expect(player.read()).toMatchObject({ active: false, positionSeconds: 0, ended: false })
    hardware.outputTime = 5.53
    expect(player.read()).toMatchObject({ active: true, positionSeconds: 0.5, ended: false })
    hardware.rendered()
    expect(player.read().ended).toBe(false)
    hardware.outputTime = 7.03
    expect(player.read()).toMatchObject({ positionSeconds: 2, ended: true })
  })
  it('freezes on pause, restarts from the saved offset, and recalculates after seek', async () => {
    const hardware = device()
    const player = new AudioPlayer(hardware)
    await player.load(new Uint8Array(1), 2)
    await player.play()
    hardware.outputTime = 5.53
    expect(player.pause()).toBeCloseTo(0.5)
    hardware.nowMs += 10_000
    hardware.outputTime = 5
    expect(player.read().positionSeconds).toBeCloseTo(0.5)
    await player.play()
    hardware.outputTime = 5.73
    expect(player.read().positionSeconds).toBeCloseTo(1.2)
    player.seek(0.2)
    await player.play()
    hardware.outputTime = 5.33
    expect(player.read().positionSeconds).toBeCloseTo(0.5)
  })
  it('freezes when the context is interrupted and fails a stale output clock', async () => {
    const hardware = device()
    const player = new AudioPlayer(hardware)
    await player.load(new Uint8Array(1), 2)
    await player.play()
    hardware.outputTime = 5.53
    player.read()
    hardware.state = 'suspended'
    hardware.nowMs += 100_000
    expect(player.read()).toMatchObject({ positionSeconds: 0.5, interrupted: true })
    expect(player.read()).toMatchObject({ positionSeconds: 0.5, interrupted: true })
    hardware.state = 'running'
    await player.play()
    hardware.nowMs += 2000
    hardware.outputTime = NaN
    expect(() => player.read()).toThrow()
  })
})
