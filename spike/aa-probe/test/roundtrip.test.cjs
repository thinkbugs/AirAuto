'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const PORT = 15277

function start(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script), String(PORT)], {
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

test('mock phone completes version, TLS, discovery, media setup and teardown', async t => {
  t.timeout = 30000
  const server = start('server.js', { AA_PORT: String(PORT) })
  t.after(() => { server.child.kill() })
  await waitFor(server.read, '"event":"listening"')

  const phone = start('mock-phone.js', { AA_PORT: String(PORT) })
  const code = await new Promise(resolve => phone.child.on('exit', resolve))
  assert.strictEqual(code, 0, `mock phone exited ${code}:\n${phone.read()}`)

  const serverLog = server.read()
  for (const event of ['service-discovery-request', 'channel-open-request', 'video-setup', 'video-codec-config', 'video-frame', 'byebye-request']) {
    assert.ok(serverLog.includes(`"event":"${event}"`), `missing ${event}:\n${serverLog}`)
  }
  assert.ok(serverLog.includes('"event":"tls-secure"'), 'TLS never became secure')
  assert.ok(phone.read().includes('"event":"media-ack"'), 'no media ack received')
})
