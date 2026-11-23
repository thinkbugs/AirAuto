export const CHANNEL_CMD = 1
export const CHANNEL_VIDEO = 2
export const CHANNEL_AUDIO = 3
export const CHANNEL_TTS = 4
export const CHANNEL_VR = 5
export const CHANNEL_TOUCH = 6
export const CHANNEL_DATA = 7

export const PORTS: Record<number, number> = {
  [CHANNEL_CMD]: 7240,
  [CHANNEL_VIDEO]: 8240,
  [CHANNEL_AUDIO]: 9240,
  [CHANNEL_TTS]: 9241,
  [CHANNEL_VR]: 9242,
  [CHANNEL_TOUCH]: 9340,
  [CHANNEL_DATA]: 9440,
}

export const UDP_DISCOVERY_PORT = 7999

export const CMD = {
  HU_PROTOCOL_VERSION: 98305,
  PROTOCOL_VERSION_MATCH_STATUS: 65538,
  HU_INFO: 98307,
  MD_INFO: 65540,
  HU_VIDEO_ENCODER_INIT: 98311,
  VIDEO_ENCODER_INIT: 65544,
  VIDEO_ENCODER_INIT_DONE: 65551,
  VIDEO_ENCODER_START: 98313,
  HU_STATISTICAL_INFO: 98343,
  HU_AUTHEN_RESULT_98380: 98380,
  MD_AUTHEN_RESULT: 65611,
  MD_MODULE_STATUS: 65574,
  MD_FEATURE_CONFIG_REQUEST: 65617,
  MD_FEATURE_CONFIG_DONE: 65570,
  HU_FEATURE_CONFIG_RESPONSE: 98386,
  HU_MODULE_CONTROL: 98344,
  HU_HEARTBEAT: 131074,
  MD_EXIT: 65625,
  TOUCH_ACTION: 425985,
  HARD_KEY_CODE: 425992,
  VIDEO_DATA: 131073,
} as const

export const CONNECT_STATUS_WIFI = 5
export const ACTION_DOWN = 0
export const ACTION_UP = 1
export const ACTION_MOVE = 2

export function headerSize(channel: number): number {
  return channel === CHANNEL_CMD || channel === CHANNEL_TOUCH ? 8 : 12
}

export function packMessage(channel: number, serviceType: number, payload: Buffer = Buffer.alloc(0), sequence = 0): Buffer {
  if (channel === CHANNEL_CMD || channel === CHANNEL_TOUCH) {
    const header = Buffer.alloc(8)
    header.writeUInt16BE(payload.length, 0)
    header.writeUInt16BE(0, 2)
    header.writeUInt32BE(serviceType >>> 0, 4)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(12)
  header.writeUInt32BE(payload.length, 0)
  header.writeUInt32BE(sequence >>> 0, 4)
  header.writeUInt32BE(serviceType >>> 0, 8)
  return Buffer.concat([header, payload])
}

export interface CarLifeMessage {
  serviceType: number
  payload: Buffer
}

// Incremental reader for a single CarLife channel; 8-byte headers on control/touch,
// 12-byte headers elsewhere.
export class ChannelParser {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly channel: number

  constructor(channel: number) {
    this.channel = channel
  }

  push(chunk: Buffer): CarLifeMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const size = headerSize(this.channel)
    const messages: CarLifeMessage[] = []
    while (this.buffer.length >= size) {
      let length: number
      let serviceType: number
      if (size === 8) {
        length = this.buffer.readUInt16BE(0)
        serviceType = this.buffer.readUInt32BE(4)
      } else {
        length = this.buffer.readUInt32BE(0)
        serviceType = this.buffer.readUInt32BE(8)
      }
      if (length > 16 * 1024 * 1024) throw new Error(`CarLife message length ${length} exceeds limit`)
      if (this.buffer.length < size + length) break
      const payload = this.buffer.subarray(size, size + length)
      this.buffer = this.buffer.subarray(size + length)
      messages.push({ serviceType, payload })
    }
    return messages
  }
}
