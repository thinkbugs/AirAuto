// Dev-only: exercises the compiled AA engine against the spike mock phone.
// Usage: node scripts/aa-engine-selftest.cjs
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork, spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const spike = path.join(root, 'spike', 'aa-probe')
const sample = path.join(spike, 'sample', 'testsrc-small.h264')
const port = 15430
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms))

const mockArgs = [path.join(spike, 'mock-phone.js'), '--listen', String(port)]
if (fs.existsSync(sample)) mockArgs.push('--sample', sample)
const mock = spawn(process.execPath, mockArgs, { cwd: spike, env: { ...process.env, AA_PORT: String(port) }, stdio: 'ignore' })

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airauto-aa-selftest-'))
const engine = fork(path.join(root, 'build', 'engine', 'run.js'), [], {
  env: {
    ...process.env,
    AIRAUTO_DATA: dataDir,
    AIRAUTO_RESOURCES: path.join(root, 'resources'),
    AIRAUTO_NATIVE: path.join(root, 'build', 'native', 'AirAuto.Platform.exe'),
  },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  serialization: 'advanced',
})

const seen = { statuses: [], configs: 0, frames: 0, connected: false, stopped: false, errors: [] }
engine.on('message', message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'status') seen.statuses.push(message.status)
  if (message.type === 'video-config') seen.configs++
  if (message.type === 'video-frame') seen.frames++
  if (message.type === 'connected') seen.connected = true
  if (message.type === 'stopped') seen.stopped = true
  if (message.type === 'diagnostic' && /错误|失败/.test(message.status)) seen.errors.push(message.status)
})
engine.stderr.on('data', chunk => seen.errors.push(String(chunk).slice(0, 400)))

;(async () => {
  await timeout(900)
  engine.send({
    command: 'start',
    settings: {
      deviceType: 'android',
      aaHost: '127.0.0.1',
      aaPort: port,
      width: 640,
      height: 360,
      fps: 30,
      language: 'zh-Hans',
    },
  })
  await timeout(5000)
  engine.send({ command: 'stop' })
  await timeout(600)
  mock.kill()
  engine.kill()

  const ok = seen.configs > 0 && seen.frames >= 5 && seen.connected
  console.log(JSON.stringify({ ok, configs: seen.configs, frames: seen.frames, connected: seen.connected, stopped: seen.stopped, statuses: seen.statuses.slice(0, 10), errors: seen.errors.slice(0, 3) }))
  process.exit(ok ? 0 : 1)
})().catch(error => {
  console.error(error)
  mock.kill()
  engine.kill()
  process.exit(1)
})
