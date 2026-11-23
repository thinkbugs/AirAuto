// Dev-only: compiled CarLife engine against the mock phone.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork, spawn } = require('node:child_process')

const root = path.join(__dirname, '..')
const mock = spawn(process.execPath, [path.join(__dirname, 'carlife-mock.cjs')], { cwd: root, stdio: 'ignore' })
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airauto-carlife-selftest-'))
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
engine.stderr.on('data', chunk => seen.errors.push(String(chunk).slice(0, 300)))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

;(async () => {
  await wait(900)
  engine.send({
    command: 'start',
    settings: { deviceType: 'carlife', carlifeHost: '127.0.0.1', width: 640, height: 360, fps: 30, language: 'zh-Hans' },
  })
  await wait(5000)
  engine.send({ command: 'stop' })
  await wait(600)
  engine.kill()
  mock.kill()
  const ok = seen.configs > 0 && seen.frames >= 5 && seen.connected
  console.log(JSON.stringify({ ok, configs: seen.configs, frames: seen.frames, connected: seen.connected, stopped: seen.stopped, statuses: seen.statuses.slice(0, 12), errors: seen.errors.slice(0, 3) }))
  process.exit(ok ? 0 : 1)
})().catch(error => {
  console.error(error)
  engine.kill()
  mock.kill()
  process.exit(1)
})
