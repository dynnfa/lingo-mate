import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

if (!process.argv[2])
  throw new Error('Required: speech-prepare-resources.mjs <new isolated model directory>')
const destination = resolve(process.argv[2])
const manifest = JSON.parse(
  await readFile(new URL('../resources/speech/headtts/manifest.json', import.meta.url), 'utf8')
)
const staging = await mkdtemp(join(dirname(destination), `${basename(destination)}-install-`))
try {
  for (const file of manifest.files) {
    const response = await fetch(
      `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file.path}`,
      { signal: AbortSignal.timeout(600_000), credentials: 'omit' }
    )
    if (!response.ok || !response.body) throw new Error(`Resource download failed: ${file.path}`)
    let size = 0
    const hash = createHash('sha256')
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > file.bytes) return callback(new Error(`Resource size exceeded: ${file.path}`))
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await mkdir(dirname(join(staging, file.path)), { recursive: true, mode: 0o700 })
    await pipeline(
      Readable.fromWeb(response.body),
      verify,
      createWriteStream(join(staging, file.path), { flags: 'wx', mode: 0o600 })
    )
    if (size !== file.bytes || hash.digest('hex') !== file.sha256)
      throw new Error(`Resource identity failed: ${file.path}`)
  }
  await rename(staging, destination)
  console.log(`Verified FP32 test resources installed: ${destination}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
