/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- Electron main-process smoke harness. */
// Deliberately does not import the application's main entry or create a window.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const [modelPath, runtimePath, scratch, samplesPath, reportPath, artifactPath] =
  process.argv.slice(2)
app.setPath('userData', path.join(scratch, 'user-data'))
const samples = JSON.parse(fs.readFileSync(samplesPath, 'utf8'))
let child
let memory
let finished = false
let diagnostic = ''
const results = []
const finish = (code, extra = {}) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  clearInterval(memory)
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        status: code ? 'failed' : 'ok',
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        results,
        ...extra
      },
      null,
      2
    )
  )
  child?.kill()
  app.exit(code)
}
const timer = setTimeout(() => finish(1, { diagnostic: 'Runtime hard deadline' }), 180_000)
app
  .whenReady()
  .then(() => {
    child = utilityProcess.fork(runtimePath, [], {
      env: { NODE_ENV: 'production', TMPDIR: scratch },
      stdio: 'pipe'
    })
    let index = -1
    let start = performance.now()
    let coldMs = 0
    let peakKb = 0
    let activeId
    let identity
    memory = setInterval(() => {
      for (const metric of app.getAppMetrics())
        if (metric.pid === child.pid) peakKb = Math.max(peakKb, metric.memory.workingSetSize)
    }, 25)
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        if (diagnostic.length < 16000)
          diagnostic += String(chunk).slice(0, 16000 - diagnostic.length)
      })
    child.on('exit', () => finish(1, { diagnostic: 'Unexpected runtime exit. ' + diagnostic }))
    const next = () => {
      index++
      if (index === samples.length) return finish(0, { identity, coldMs, peakKb })
      activeId = randomUUID()
      start = performance.now()
      const sample = samples[index]
      child.postMessage({
        type: 'synthesize',
        id: activeId,
        text: sample.text,
        settings: { voice: sample.voice, speed: sample.speed }
      })
    }
    child.on('message', (message) => {
      try {
        if (message.type === 'ready') {
          coldMs = performance.now() - start
          identity = message.identity
          if (identity.dtype !== 'fp32' || identity.device !== 'cpu')
            throw new Error('Runtime identity mismatch')
          next()
        } else if (message.type === 'audio' && message.id === activeId) {
          const segment = message.segment
          const bytes = Buffer.from(segment.audio)
          const duration = bytes.readUInt32LE(40) / 48000
          if (
            bytes.toString('ascii', 0, 4) !== 'RIFF' ||
            bytes.readUInt32LE(4) !== bytes.length - 8 ||
            segment.words.join('') !== samples[index].text ||
            segment.words.length !== segment.wtimes.length ||
            segment.words.length !== segment.wdurations.length
          )
            throw new Error('Invalid audio contract')
          let previousEnd = 0
          for (let i = 0; i < segment.words.length; i++) {
            const from = segment.wtimes[i] / 1000
            const to = (segment.wtimes[i] + segment.wdurations[i]) / 1000
            if (
              !Number.isFinite(to) ||
              from < previousEnd - 0.00105 ||
              to > duration + 0.00105 ||
              to <= from
            )
              throw new Error(`Invalid timestamp at sample ${index}, word ${i}`)
            previousEnd = to
          }
          if (artifactPath) fs.writeFileSync(path.join(artifactPath, `sample-${index}.wav`), bytes)
          results.push({
            ...samples[index],
            duration,
            elapsedMs: performance.now() - start,
            words: segment.words,
            wtimes: segment.wtimes,
            wdurations: segment.wdurations
          })
          next()
        } else throw new Error(`Unexpected runtime response: ${message.type}`)
      } catch (error) {
        finish(1, { diagnostic: String(error) + diagnostic })
      }
    })
    child.postMessage({ type: 'init', modelPath })
  })
  .catch((error) => finish(1, { diagnostic: String(error) }))
