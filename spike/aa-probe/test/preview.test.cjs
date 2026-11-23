'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const AA_PORT = 15331
const PREVIEW_PORT = 15601

function start(script, args, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, read: () => output }
}

function waitFor(read, needle, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (read().includes(needle)) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for ${needle}; output:\n${read()}`))
      }
    }, 50)
  })
}

test('preview page receives codec config and one frame', async t => {
  t.timeout = 30000
  const server = start('server.js', ['--preview', String(PREVIEW_PORT)], { AA_PORT: String(AA_PORT) })
  t.after(() => server.child.kill())
  await waitFor(server.read, '"event":"preview-listening"')

  const socket = new WebSocket(`ws://127.0.0.1:${PREVIEW_PORT}/ws`)
  const received = { config: null, frame: null }
  socket.on('message', (data, binary) => {
    if (binary) {
      received.frame = Buffer.from(data)
    } else {
      received.config = JSON.parse(String(data))
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const phone = start('mock-phone.js', [], { AA_PORT: String(AA_PORT) })
  t.after(() => phone.child.kill())
  const code = await new Promise(resolve => phone.child.on('exit', resolve))
  assert.strictEqual(code, 0, `mock phone exited ${code}:\n${phone.read()}`)
  await new Promise(resolve => setTimeout(resolve, 300))

  assert.ok(received.config, 'no config over preview websocket')
  assert.match(received.config.codec, /^avc1\./)
  assert.ok(received.config.description.length > 0)
  assert.ok(received.frame, 'no binary frame over preview websocket')
  assert.strictEqual(received.frame[0], 1, 'first frame should be a keyframe')
  assert.ok(received.frame.length > 9)
  socket.close()
})
