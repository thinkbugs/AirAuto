'use strict'

// AAP frame layout (verified against DiAuto AapMessage/AapReadMultipleMessages/MediaPlayback):
//   offset 0: channel (u8)
//   offset 1: flags   (u8)
//   offset 2: length  (u16 BE) = 2-byte message type + payload, exclusive of header
//   offset 4: when flags === 0x09 (first fragment) an extra u32 BE total size follows,
//             and it is *not* included in `length`
// The 2-byte message type lives in the body for plaintext frames. For encrypted frames the
// body is a raw TLS record and the type byte pair sits inside the decrypted stream.

const HEADER_SIZE = 4
const FLAG_FIRST_FRAGMENT = 0x09
const FLAG_MIDDLE_FRAGMENT = 0x08
const FLAG_LAST_FRAGMENT = 0x0a
const FLAG_HANDSHAKE = 0x03
const FLAG_ENCRYPTED = 0x08
const FLAG_BIT_FIRST = 0x01
const FLAG_BIT_LAST = 0x02

const CONTROL_MSG = {
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
}

const MEDIA_MSG = {
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
}

const CHANNEL = {
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
  NOTIFICATION: 11,
  PHONE_STATUS: 12,
  WIFI: 13,
}

// Mirrors AapMessage.flags(): control-range types on a non-control channel get the
// "control type" marker, everything else the default.
function defaultFlags(channel, type) {
  return channel !== CHANNEL.CONTROL && type >= 1 && type <= 26 ? 0x0f : 0x0b
}

function encodeFrame({ channel, flags, type, payload = Buffer.alloc(0), declaredTotal }) {
  // Encrypted frames carry a raw TLS record; the message type lives inside the plaintext.
  let body
  if (flags & FLAG_ENCRYPTED) {
    body = Buffer.from(payload)
  } else {
    body = Buffer.alloc(2 + payload.length)
    body.writeUInt16BE(type >>> 0, 0)
    payload.copy(body, 2)
  }
  const extra = flags === FLAG_FIRST_FRAGMENT
    ? Buffer.alloc(4).fill(0)
    : null
  if (extra) extra.writeUInt32BE(declaredTotal >>> 0, 0)
  const header = Buffer.alloc(HEADER_SIZE)
  header[0] = channel & 0xff
  header[1] = flags & 0xff
  header.writeUInt16BE(body.length, 2)
  return extra ? Buffer.concat([header, extra, body]) : Buffer.concat([header, body])
}

function encodeRaw(channel, flags, type, payload = Buffer.alloc(0)) {
  return encodeFrame({ channel, flags, type, payload })
}

class FrameParser {
  constructor(limit = 4 * 1024 * 1024) {
    this.buffer = Buffer.alloc(0)
    this.limit = limit
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames = []
    while (this.buffer.length >= HEADER_SIZE) {
      const channel = this.buffer[0]
      const flags = this.buffer[1]
      const length = this.buffer.readUInt16BE(2)
      const extra = flags === FLAG_FIRST_FRAGMENT ? 4 : 0
      if (length > this.limit) throw new Error(`AAP frame length ${length} exceeds limit`)
      const total = HEADER_SIZE + extra + length
      if (this.buffer.length < total) break
      let declaredTotal
      let offset = HEADER_SIZE
      if (extra) {
        declaredTotal = this.buffer.readUInt32BE(HEADER_SIZE)
        offset += extra
      }
      const body = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(total)
      let type = null
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

module.exports = {
  HEADER_SIZE,
  FLAG_FIRST_FRAGMENT,
  FLAG_MIDDLE_FRAGMENT,
  FLAG_LAST_FRAGMENT,
  FLAG_HANDSHAKE,
  FLAG_ENCRYPTED,
  FLAG_BIT_FIRST,
  FLAG_BIT_LAST,
  CONTROL_MSG,
  MEDIA_MSG,
  CHANNEL,
  defaultFlags,
  encodeFrame,
  encodeRaw,
  FrameParser,
}
