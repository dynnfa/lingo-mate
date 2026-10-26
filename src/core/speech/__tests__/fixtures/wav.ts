export function wav(seconds = 1): Uint8Array {
  const bytes = new Uint8Array(44 + 24000 * 2 * seconds)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string): void => {
    ;[...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, bytes.length - 44, true)
  return bytes
}
