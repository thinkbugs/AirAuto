'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { VideoPipeline } = require('../lib/video')
const { FLAG_FIRST_FRAGMENT, FLAG_MIDDLE_FRAGMENT, FLAG_LAST_FRAGMENT } = require('../lib/framing')

const CONFIG = Buffer.from('000000016742001e95a8280f0044fcb80000000168ce3c80', 'hex')
const IDR = Buffer.from('0000000165b80410ffff', 'hex')

test('configures from SPS/PPS and exposes a WebCodecs description', () => {
  const pipeline = new VideoPipeline()
  const configured = pipeline.configure(CONFIG)
  assert.ok(configured)
  assert.strictEqual(configured.codec.slice(0, 5), 'avc1.')
  assert.ok(configured.description.length > 10)
  assert.strictEqual(pipeline.description.toString('hex'), configured.description.toString('hex'))
})

test('pushes a single complete frame (flags 0x0b)', () => {
  const pipeline = new VideoPipeline()
  pipeline.configure(CONFIG)
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigUInt64BE(42n)
  const frame = pipeline.push(Buffer.concat([timestamp, IDR]), 0x0b)
  assert.ok(frame)
  assert.strictEqual(frame.keyframe, true)
  assert.strictEqual(frame.nals[0], 5)
  assert.strictEqual(frame.data.readUInt32BE(0), frame.data.length - 4)
  assert.strictEqual(pipeline.stats.accessUnits, 1)
})

test('reassembles a fragmented frame', () => {
  const pipeline = new VideoPipeline()
  pipeline.configure(CONFIG)
  const a = IDR.subarray(0, 7)
  const b = IDR.subarray(7)
  assert.strictEqual(pipeline.push(a, FLAG_FIRST_FRAGMENT), null)
  assert.strictEqual(pipeline.push(b, FLAG_MIDDLE_FRAGMENT), null)
  const frame = pipeline.push(Buffer.alloc(0), FLAG_LAST_FRAGMENT)
  assert.ok(frame)
  assert.strictEqual(frame.keyframe, true)
})

test('drops orphaned fragments instead of assembling garbage', () => {
  const pipeline = new VideoPipeline()
  pipeline.configure(CONFIG)
  assert.strictEqual(pipeline.push(IDR, FLAG_MIDDLE_FRAGMENT), null)
  assert.strictEqual(pipeline.stats.orphanFragments, 1)
})
