import { NAL_SPS, NAL_PPS, splitAnnexB, buildAvcC, parseSps, isKeyframe, startsWithStartCode, type SpsInfo } from '../aa/nalu'

export interface CarLifeVideoConfig {
  description: Buffer
  info: SpsInfo
  width: number | null
  height: number | null
}

export interface CarLifeVideoFrame {
  data: Buffer
  keyframe: boolean
}

// CarLife video packets carry H.264 access units (usually Annex-B, sometimes length
// prefixed). SPS/PPS arrive in-band; build the WebCodecs description once seen.
export class CarLifeVideo {
  private sps?: Buffer
  private pps?: Buffer
  private description?: Buffer
  readonly stats = { packets: 0, frames: 0 }

  push(payload: Buffer): { config?: CarLifeVideoConfig; frame?: CarLifeVideoFrame } {
    this.stats.packets++
    const annexB = startsWithStartCode(payload) || payload.includes(Buffer.from([0, 0, 1]))
    const nals = annexB ? splitAnnexB(payload) : this.splitAvcc(payload)
    if (!nals.length) return {}
    const sps = nals.find(nal => (nal[0] & 0x1f) === NAL_SPS)
    const pps = nals.find(nal => (nal[0] & 0x1f) === NAL_PPS)
    let config: CarLifeVideoConfig | undefined
    if (sps && pps) {
      const changed = !this.sps || !this.pps || !this.sps.equals(sps) || !this.pps.equals(pps)
      this.sps = Buffer.from(sps)
      this.pps = Buffer.from(pps)
      if (changed || !this.description) {
        this.description = buildAvcC(sps, pps)
        let info: SpsInfo
        try {
          info = parseSps(sps)
        } catch {
          info = { profileIdc: sps[1], constraintFlags: sps[2], levelIdc: sps[3], width: null, height: null, chromaFormatIdc: 1 }
        }
        config = { description: this.description, info, width: info.width, height: info.height }
      }
    }
    const media = nals.filter(nal => {
      const type = nal[0] & 0x1f
      return type !== NAL_SPS && type !== NAL_PPS
    })
    if (!media.length) return { config }
    const data = this.toAvcc(media)
    this.stats.frames++
    return { config, frame: { data, keyframe: isKeyframe(media) } }
  }

  private splitAvcc(payload: Buffer): Buffer[] {
    const nals: Buffer[] = []
    let offset = 0
    while (offset + 4 <= payload.length) {
      const length = payload.readUInt32BE(offset)
      offset += 4
      if (length < 1 || offset + length > payload.length) return []
      nals.push(payload.subarray(offset, offset + length))
      offset += length
    }
    return offset === payload.length ? nals : []
  }

  private toAvcc(nals: Buffer[]): Buffer {
    const chunks: Buffer[] = []
    for (const nal of nals) {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(nal.length, 0)
      chunks.push(length, nal)
    }
    return Buffer.concat(chunks)
  }
}
