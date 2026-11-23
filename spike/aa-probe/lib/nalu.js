'use strict'

// H.264 helpers for the AA video channel: Annex-B splitting, SPS parsing (just enough for
// WebCodecs configuration), AVCDecoderConfigurationRecord building and AVCC conversion.

const NAL_SPS = 7
const NAL_PPS = 8
const NAL_IDR = 5

function isStartCode(buffer, offset) {
  return buffer.length >= offset + 3 && buffer[offset] === 0 && buffer[offset + 1] === 0 &&
    (buffer[offset + 2] === 1 || (buffer[offset + 2] === 0 && buffer[offset + 3] === 1))
}

function startsWithStartCode(buffer) {
  return isStartCode(buffer, 0)
}

function startCodeLength(buffer, offset) {
  return buffer[offset + 2] === 1 ? 3 : 4
}

// Returns NAL payloads without start codes. A leading timestamp (AA prepends 8 bytes on
// some frames) is the caller's problem, not this function's.
function splitAnnexB(buffer) {
  const nals = []
  let offset = -1
  for (let i = 0; i + 2 < buffer.length; i++) {
    if (isStartCode(buffer, i)) {
      if (offset >= 0) {
        const end = i
        const trim = end > offset && buffer[end - 1] === 0 ? 1 : 0
        if (end - trim > offset) nals.push(buffer.subarray(offset, end - trim))
      }
      offset = i + startCodeLength(buffer, i)
      i = offset - 1
    }
  }
  if (offset >= 0 && offset < buffer.length) nals.push(buffer.subarray(offset))
  return nals
}

class BitReader {
  constructor(buffer) {
    this.buffer = buffer
    this.bit = 0
  }

  readBits(count) {
    let value = 0
    for (let i = 0; i < count; i++) {
      const byte = this.buffer[this.bit >> 3]
      if (byte === undefined) throw new Error('SPS bitstream exhausted')
      value = (value << 1) | ((byte >> (7 - (this.bit & 7))) & 1)
      this.bit++
    }
    return value >>> 0
  }

  readUE() {
    let zeros = 0
    while (this.readBits(1) === 0) {
      if (++zeros > 31) throw new Error('invalid exp-golomb')
    }
    return (2 ** zeros - 1) + (zeros ? this.readBits(zeros) : 0)
  }

  readSE() {
    const value = this.readUE()
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function parseSps(nal) {
  const r = new BitReader(nal.subarray(1))
  const profileIdc = r.readBits(8)
  const constraintFlags = r.readBits(8)
  const levelIdc = r.readBits(8)
  r.readUE() // seq_parameter_set_id
  let chromaFormatIdc = 1
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.readUE()
    if (chromaFormatIdc === 3) r.readBits(1) // separate_colour_plane_flag
    r.readUE() // bit_depth_luma_minus8
    r.readUE() // bit_depth_chroma_minus8
    r.readBits(1) // qpprime_y_zero_transform_bypass_flag
    if (r.readBits(1)) {
      const limit = chromaFormatIdc !== 3 ? 8 : 12
      for (let i = 0; i < limit; i++) {
        if (r.readBits(1)) {
          const size = i < 6 ? 16 : 64
          let last = 8
          let next = 8
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.readSE() + 256) % 256
            last = next === 0 ? last : next
          }
        }
      }
    }
  }
  r.readUE() // log2_max_frame_num_minus4
  const pocType = r.readUE()
  if (pocType === 0) {
    r.readUE()
  } else if (pocType === 1) {
    r.readBits(1)
    r.readSE()
    r.readSE()
    const cycle = r.readUE()
    for (let i = 0; i < cycle; i++) r.readSE()
  }
  r.readUE() // max_num_ref_frames
  r.readBits(1) // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.readUE() + 1
  const heightMapUnits = r.readUE() + 1
  const frameMbsOnly = r.readBits(1)
  if (!frameMbsOnly) r.readBits(1)
  r.readBits(1) // direct_8x8_inference_flag
  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0
  if (r.readBits(1)) {
    cropLeft = r.readUE()
    cropRight = r.readUE()
    cropTop = r.readUE()
    cropBottom = r.readUE()
  }
  const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1
  const chromaArrayType = chromaFormatIdc === 3 ? 0 : chromaFormatIdc
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC
  const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnly)
  const width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight)
  const height = heightMapUnits * 16 * (2 - frameMbsOnly) - cropUnitY * (cropTop + cropBottom)
  return { profileIdc, constraintFlags, levelIdc, width, height, chromaFormatIdc }
}

function buildAvcC(sps, pps) {
  if (!sps || !pps) throw new Error('SPS/PPS required for avcC')
  const header = Buffer.from([0x01, sps[1], sps[2], sps[3], 0xff, 0xe1, (sps.length >> 8) & 0xff, sps.length & 0xff])
  const ppsHeader = Buffer.from([0x01, (pps.length >> 8) & 0xff, pps.length & 0xff])
  return Buffer.concat([header, sps, ppsHeader, pps])
}

function toAvcc(nals) {
  const chunks = []
  for (const nal of nals) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(nal.length, 0)
    chunks.push(length, nal)
  }
  return Buffer.concat(chunks)
}

function isKeyframe(nals) {
  return nals.some(nal => (nal[0] & 0x1f) === NAL_IDR)
}

module.exports = {
  NAL_SPS,
  NAL_PPS,
  NAL_IDR,
  startsWithStartCode,
  splitAnnexB,
  parseSps,
  buildAvcC,
  toAvcc,
  isKeyframe,
  BitReader,
}
