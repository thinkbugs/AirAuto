export interface AapFrame {
  channel: number
  flags: number
  length: number
  declaredTotal?: number
  type: number | null
  payload: Buffer
}

export const HEADER_SIZE = 4
export const FLAG_FIRST_FRAGMENT = 0x09
export const FLAG_MIDDLE_FRAGMENT = 0x08
export const FLAG_LAST_FRAGMENT = 0x0a
export const FLAG_HANDSHAKE = 0x03
export const FLAG_ENCRYPTED = 0x08
export const FLAG_BIT_FIRST = 0x01
export const FLAG_BIT_LAST = 0x02

export const CONTROL_MSG = {
  VERSION_REQUEST: 1,
  VERSION_RESPONSE: 2,
  ENCAPSULATED_SSL: 3,
  AUTH_COMPLETE: 4,
  SERVICE_DISCOVERY_REQUEST: 5,
  SERVICE_DISCOVERY_RESPONSE: 6,
  CHANNEL_OPEN_REQUEST: 7,
  CHANNEL_OPEN_RESPONSE: 8,
  CHANNEL_CLOSE_NOTIFICATION: 9,
  PING_REQUEST: 11,
  PING_RESPONSE: 12,
  NAV_FOCUS_REQUEST: 13,
  NAV_FOCUS_NOTIFICATION: 14,
  BYEBYE_REQUEST: 15,
  BYEBYE_RESPONSE: 16,
  VOICE_SESSION_NOTIFICATION: 17,
  AUDIO_FOCUS_REQUEST: 18,
  AUDIO_FOCUS_NOTIFICATION: 19,
  BATTERY_STATUS_NOTIFICATION: 23,
} as const

export const MEDIA_MSG = {
  DATA: 0x0000,
  CODEC_CONFIG: 0x0001,
  SETUP: 0x8000,
  START: 0x8001,
  STOP: 0x8002,
  CONFIG: 0x8003,
  ACK: 0x8004,
  MICROPHONE_REQUEST: 0x8005,
  MICROPHONE_RESPONSE: 0x8006,
  VIDEO_FOCUS_REQUEST: 0x8007,
  VIDEO_FOCUS_NOTIFICATION: 0x8008,
  UPDATE_UI_CONFIG_REQUEST: 0x8009,
  UPDATE_UI_CONFIG_REPLY: 0x800a,
  AUDIO_UNDERFLOW_NOTIFICATION: 0x800b,
} as const

export const CHANNEL = {
  CONTROL: 0,
  SENSOR: 1,
  VIDEO: 2,
  INPUT: 3,
  AUDIO1: 4,
  AUDIO2: 5,
  AUDIO: 6,
  MIC: 7,
  BLUETOOTH: 8,
  MEDIA_PLAYBACK: 9,
  NAVIGATION: 10,
} as const

export function defaultFlags(channel: number, type: number): number {
  return channel !== CHANNEL.CONTROL && type >= 1 && type <= 26 ? 0x0f : 0x0b
}

export function encodeFrame(options: { channel: number; flags: number; type: number | null; payload?: Buffer; declaredTotal?: number }): Buffer {
  const payload = options.payload ?? Buffer.alloc(0)
  let body: Buffer
  if (options.flags & FLAG_ENCRYPTED) {
    body = Buffer.from(payload)
  } else {
    body = Buffer.alloc(2 + payload.length)
    body.writeUInt16BE((options.type ?? 0) >>> 0, 0)
    payload.copy(body, 2)
  }
  const header = Buffer.alloc(HEADER_SIZE)
  header[0] = options.channel & 0xff
  header[1] = options.flags & 0xff
  header.writeUInt16BE(body.length, 2)
  if (options.flags === FLAG_FIRST_FRAGMENT) {
    const extra = Buffer.alloc(4)
    extra.writeUInt32BE((options.declaredTotal ?? 0) >>> 0, 0)
    return Buffer.concat([header, extra, body])
  }
  return Buffer.concat([header, body])
}

export function encodeTlsRecord(channel: number, flags: number, record: Buffer, declaredTotal?: number): Buffer {
  const header = Buffer.alloc(4)
  header[0] = channel & 0xff
  header[1] = flags & 0xff
  header.writeUInt16BE(record.length, 2)
  if (flags === 0x09) {
    const extra = Buffer.alloc(4)
    extra.writeUInt32BE((declaredTotal ?? 0) >>> 0, 0)
    return Buffer.concat([header, extra, record])
  }
  return Buffer.concat([header, record])
}

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly limit: number

  constructor(limit = 4 * 1024 * 1024) {
    this.limit = limit
  }

  push(chunk: Buffer): AapFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames: AapFrame[] = []
    while (this.buffer.length >= HEADER_SIZE) {
      const channel = this.buffer[0]
      const flags = this.buffer[1]
      const length = this.buffer.readUInt16BE(2)
      const extra = flags === FLAG_FIRST_FRAGMENT ? 4 : 0
      if (length > this.limit) throw new Error(`AAP frame length ${length} exceeds limit`)
      const total = HEADER_SIZE + extra + length
      if (this.buffer.length < total) break
      let declaredTotal: number | undefined
      let offset = HEADER_SIZE
      if (extra) {
        declaredTotal = this.buffer.readUInt32BE(HEADER_SIZE)
        offset += extra
      }
      const body = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(total)
      let type: number | null = null
      let payload = body
      if (!(flags & FLAG_ENCRYPTED)) {
        if (length < 2) throw new Error('AAP plaintext frame without message type')
        type = body.readUInt16BE(0)
        payload = body.subarray(2)
      }
      frames.push({ channel, flags, length, declaredTotal, type, payload })
    }
    return frames
  }
}
