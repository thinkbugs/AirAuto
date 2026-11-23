'use strict'

const {
  NAL_SPS,
  NAL_PPS,
  startsWithStartCode,
  splitAnnexB,
  parseSps,
  buildAvcC,
  toAvcc,
  isKeyframe,
} = require('./nalu')

// Media data frames may be prefixed with an 8-byte timestamp; config and single frames may
// not. Start codes tell the two apart.
function stripTimestamp(payload) {
  if (startsWithStartCode(payload)) return { data: payload, timestamp: null }
  if (payload.length > 8 && startsWithStartCode(payload.subarray(8))) {
    return { data: payload.subarray(8), timestamp: payload.readBigUInt64BE(0) }
  }
  return { data: payload, timestamp: null }
}

function codecString(info) {
  const hex = value => value.toString(16).padStart(2, '0')
  return `avc1.${hex(info.profileIdc)}${hex(info.constraintFlags)}${hex(info.levelIdc)}`
}

class VideoPipeline {
  constructor() {
    this.description = null
    this.info = null
    this.assembly = null
    this.stats = { accessUnits: 0, keyframes: 0, bytes: 0, orphanFragments: 0 }
  }

  // Codec config carries SPS/PPS. Returns { description, info, codec } on first success.
  configure(payload) {
    const { data } = stripTimestamp(payload)
    const nals = splitAnnexB(data)
    const sps = nals.find(nal => (nal[0] & 0x1f) === NAL_SPS)
    const pps = nals.find(nal => (nal[0] & 0x1f) === NAL_PPS)
    if (!sps || !pps) return null
    let info
    try {
      info = parseSps(sps)
    } catch {
      info = { profileIdc: sps[1], constraintFlags: sps[2], levelIdc: sps[3], width: null, height: null }
    }
    this.info = info
    this.description = buildAvcC(sps, pps)
    return { description: this.description, info, codec: codecString(info) }
  }

  // flags bit 0 = first fragment, bit 1 = last. 0x0b is a complete single frame.
  push(payload, flags) {
    const first = (flags & 0x01) !== 0
    const last = (flags & 0x02) !== 0
    const { data, timestamp } = stripTimestamp(payload)
    if (first) {
      this.assembly = { chunks: [data], timestamp }
    } else if (this.assembly) {
      this.assembly.chunks.push(data)
    } else {
      this.stats.orphanFragments++
      return null
    }
    if (!last) return null
    const au = Buffer.concat(this.assembly.chunks)
    const ts = this.assembly.timestamp
    this.assembly = null
    return this.#finish(au, ts)
  }

  #finish(accessUnit, timestamp) {
    const nals = splitAnnexB(accessUnit).filter(nal => nal.length)
    if (!nals.length) return null
    const avcc = toAvcc(nals)
    const keyframe = isKeyframe(nals)
    this.stats.accessUnits++
    this.stats.bytes += avcc.length
    if (keyframe) this.stats.keyframes++
    return {
      data: avcc,
      keyframe,
      timestamp,
      bytes: avcc.length,
      nals: nals.map(nal => nal[0] & 0x1f),
    }
  }
}

module.exports = { VideoPipeline, stripTimestamp, codecString }
