'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { encodeFrame, FrameParser, FLAG_FIRST_FRAGMENT } = require('../lib/framing')

test('plaintext frame round-trip', () => {
  const frame = encodeFrame({ channel: 0, flags: 3, type: 2, payload: Buffer.from([0, 1, 0, 0]) })
  assert.deepStrictEqual(frame, Buffer.from([0, 3, 0, 6, 0, 2, 0, 1, 0, 0]))
  const [parsed] = new FrameParser().push(frame)
  assert.strictEqual(parsed.channel, 0)
  assert.strictEqual(parsed.flags, 3)
  assert.strictEqual(parsed.type, 2)
  assert.deepStrictEqual(parsed.payload, Buffer.from([0, 1, 0, 0]))
})

test('encrypted frame keeps record intact and has no inline type', () => {
  const record = Buffer.from('160303000401020304', 'hex')
  const frame = encodeFrame({ channel: 2, flags: 0x0b, type: 0, payload: record })
  const [parsed] = new FrameParser().push(frame)
  assert.strictEqual(parsed.channel, 2)
  assert.strictEqual(parsed.flags, 0x0b)
  assert.strictEqual(parsed.type, null)
  assert.deepStrictEqual(parsed.payload, record)
})

test('first fragment carries extra total-size field outside the length', () => {
  const frame = encodeFrame({
    channel: 2,
    flags: FLAG_FIRST_FRAGMENT,
    type: 0,
    payload: Buffer.from('deadbeef', 'hex'),
    declaredTotal: 0x12345678,
  })
  assert.strictEqual(frame.readUInt16BE(2), 4)
  assert.strictEqual(frame.readUInt32BE(4), 0x12345678)
  const [parsed] = new FrameParser().push(frame)
  assert.strictEqual(parsed.declaredTotal, 0x12345678)
  assert.strictEqual(parsed.payload.toString('hex'), 'deadbeef')
})

test('parser handles byte-by-byte delivery and multiple frames per chunk', () => {
  const a = encodeFrame({ channel: 0, flags: 3, type: 1, payload: Buffer.from([0, 1, 0, 2]) })
  const b = encodeFrame({ channel: 0, flags: 3, type: 2, payload: Buffer.from([0, 1, 0, 0]) })
  const parser = new FrameParser()
  const collected = []
  for (const byte of Buffer.concat([a, b])) collected.push(...parser.push(Buffer.from([byte])))
  assert.strictEqual(collected.length, 2)
  assert.deepStrictEqual(collected.map(f => f.type), [1, 2])
})
