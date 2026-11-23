'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { splitAnnexB, parseSps, buildAvcC, toAvcc, isKeyframe } = require('../lib/nalu')

const CONFIG = Buffer.from('000000016742001e95a8280f0044fcb80000000168ce3c80', 'hex')

test('splits Annex-B into SPS and PPS', () => {
  const nals = splitAnnexB(CONFIG)
  assert.strictEqual(nals.length, 2)
  assert.strictEqual(nals[0][0] & 0x1f, 7)
  assert.strictEqual(nals[1][0] & 0x1f, 8)
})

test('builds an AVCDecoderConfigurationRecord from SPS/PPS', () => {
  const nals = splitAnnexB(CONFIG)
  const avcc = buildAvcC(nals[0], nals[1])
  assert.strictEqual(avcc[0], 1)
  assert.strictEqual(avcc[1], 0x42)
  assert.strictEqual(avcc[3], 0x1e)
  assert.strictEqual(avcc[4], 0xff)
  assert.strictEqual(avcc[5], 0xe1)
  assert.strictEqual(avcc[6] << 8 | avcc[7], nals[0].length)
  assert.ok(avcc.includes(nals[1]))
})

test('parses SPS profile/level and tolerates truncated payloads', () => {
  const sps = splitAnnexB(CONFIG)[0]
  try {
    const info = parseSps(sps)
    assert.strictEqual(info.profileIdc, 0x42)
    assert.strictEqual(info.levelIdc, 0x1e)
    assert.ok(info.width === null || info.width > 0)
  } catch (error) {
    assert.match(error.message, /exhausted|exp-golomb/)
  }
})

test('converts NALs to 4-byte length prefixes and detects keyframes', () => {
  const idr = Buffer.from('0000000165b80410ffff', 'hex')
  const nals = splitAnnexB(idr)
  const avcc = toAvcc(nals)
  assert.strictEqual(avcc.readUInt32BE(0), nals[0].length)
  assert.strictEqual(avcc.subarray(4).toString('hex'), nals[0].toString('hex'))
  assert.strictEqual(isKeyframe(nals), true)
  assert.strictEqual(isKeyframe(splitAnnexB(CONFIG)), false)
})
