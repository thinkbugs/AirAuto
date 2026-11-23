import { NAL_SPS, NAL_PPS, startsWithStartCode, splitAnnexB, parseSps, buildAvcC, toAvcc, isKeyframe, type SpsInfo } from './nalu'

export interface VideoConfig {
  description: Buffer
  codec: string
  info: SpsInfo
}

export interface VideoAccessUnit {
  data: Buffer
  keyframe: boolean
  timestamp: bigint | null
  bytes: number
  nals: number[]
}

function stripTimestamp(payload: Buffer): { data: Buffer; timestamp: bigint | null } {
  if (startsWithStartCode(payload)) return { data: payload, timestamp: null }
  if (payload.length > 8 && startsWithStartCode(payload.subarray(8))) {
    return { data: payload.subarray(8), timestamp: payload.readBigUInt64BE(0) }
  }
  // Audio/AA senders may use a 4-byte timestamp; accept it when a start code follows.
  if (payload.length > 4 && startsWithStartCode(payload.subarray(4))) {
    return { data: payload.subarray(4), timestamp: BigInt(payload.readUInt32BE(0)) }
  }
  return { data: payload, timestamp: null }
}

function codecString(info: SpsInfo): string {
  const hex = (value: number) => value.toString(16).padStart(2, '0')
  return `avc1.${hex(info.profileIdc)}${hex(info.constraintFlags)}${hex(info.levelIdc)}`
}

export class VideoPipeline {
  description: Buffer | null = null
  info: SpsInfo | null = null
  private assembly: { chunks: Buffer[]; timestamp: bigint | null } | null = null
  readonly stats = { accessUnits: 0, keyframes: 0, bytes: 0, orphanFragments: 0 }

  configure(payload: Buffer): VideoConfig | null {
    const { data } = stripTimestamp(payload)
    const nals = splitAnnexB(data)
    const sps = nals.find(nal => (nal[0] & 0x1f) === NAL_SPS)
    const pps = nals.find(nal => (nal[0] & 0x1f) === NAL_PPS)
    if (!sps || !pps) return null
    let info: SpsInfo
    try {
      info = parseSps(sps)
    } catch {
      info = { profileIdc: sps[1], constraintFlags: sps[2], levelIdc: sps[3], width: null, height: null, chromaFormatIdc: 1 }
    }
    this.info = info
    this.description = buildAvcC(sps, pps)
    return { description: this.description, info, codec: codecString(info) }
  }

  push(payload: Buffer, flags: number): VideoAccessUnit | null {
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
    const accessUnit = Buffer.concat(this.assembly.chunks)
    const ts = this.assembly.timestamp
    this.assembly = null
    return this.finish(accessUnit, ts)
  }

  private finish(accessUnit: Buffer, timestamp: bigint | null): VideoAccessUnit | null {
    const nals = splitAnnexB(accessUnit).filter(nal => nal.length)
    if (!nals.length) return null
    const avcc = toAvcc(nals)
    const keyframe = isKeyframe(nals)
    this.stats.accessUnits++
    this.stats.bytes += avcc.length
    if (keyframe) this.stats.keyframes++
    return { data: avcc, keyframe, timestamp, bytes: avcc.length, nals: nals.map(nal => nal[0] & 0x1f) }
  }
}
