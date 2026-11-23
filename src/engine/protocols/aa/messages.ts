import path from 'node:path'
import protobuf from 'protobufjs'

const PROTO_DIR = path.join(__dirname, 'proto')
const PACKAGE = 'com.andrerinas.openheadunit.aap.protocol.proto'

// input.proto and media.proto both declare MsgType in the same package; keep separate roots.
const roots = [
  ['control.proto'],
  ['input.proto'],
  ['navigation.proto'],
  ['playback.proto'],
  ['wireless.proto'],
].map(files => {
  const root = new protobuf.Root()
  root.loadSync(files.map(file => path.join(PROTO_DIR, file)), { keepCase: true })
  return root
})

function type(name: string): protobuf.Type {
  for (const root of roots) {
    try {
      return root.lookupType(`${PACKAGE}.${name}`)
    } catch {}
  }
  throw new Error(`AA proto type not found: ${name}`)
}

export function encode(name: string, value: object): Buffer {
  const messageType = type(name)
  const error = messageType.verify(value)
  if (error) throw new Error(`${name}: ${error}`)
  return Buffer.from(messageType.encode(messageType.fromObject(value)).finish())
}

export function decode<T = Record<string, any>>(name: string, buffer: Buffer): T {
  return type(name).toObject(type(name).decode(buffer)) as T
}

export interface ServiceDiscoveryOptions {
  width: number
  height: number
  fps: number
  density: number
}

function resolution(width: number, height: number): number {
  if (width >= 1920 || height >= 1080) return 3
  if (width >= 1280 || height >= 720) return 2
  return 1
}

export function serviceDiscoveryResponse({ width, height, fps, density }: ServiceDiscoveryOptions): Buffer {
  const services = [
    { id: 1, sensor_source_service: { sensors: [{ type: 13 }, { type: 10 }] } },
    {
      id: 2,
      media_sink_service: {
        available_type: 3,
        audio_type: 0,
        available_while_in_call: true,
        video_configs: [{
          codec_resolution: resolution(width, height),
          frame_rate: fps >= 60 ? 1 : 2,
          margin_width: 0,
          margin_height: 0,
          density,
          video_codec_type: 3,
        }],
      },
    },
    {
      id: 3,
      input_source_service: { touchscreen: { width, height }, keycodes_supported: [] },
    },
    { id: 5, media_sink_service: { available_type: 1, audio_type: 2, audio_configs: [{ sample_rate: 48000, number_of_bits: 16, number_of_channels: 2 }] } },
    { id: 4, media_sink_service: { available_type: 1, audio_type: 1, audio_configs: [{ sample_rate: 16000, number_of_bits: 16, number_of_channels: 1 }] } },
    { id: 6, media_sink_service: { available_type: 1, audio_type: 3, audio_configs: [{ sample_rate: 48000, number_of_bits: 16, number_of_channels: 2 }] } },
    { id: 7, media_source_service: { type: 1, audio_config: { sample_rate: 16000, number_of_bits: 16, number_of_channels: 1 } } },
  ]
  return encode('ServiceDiscoveryResponse', {
    services,
    make: 'AirAuto',
    model: 'AirAuto',
    year: String(new Date().getFullYear()),
    vehicle_id: 'AIRAUTO-AA-0001',
    driver_position: 0,
    head_unit_make: 'AirAuto',
    head_unit_model: 'AirAuto Head Unit',
    head_unit_software_build: '1',
    head_unit_software_version: '1.0.0',
    can_play_native_media_during_vr: false,
    hide_projected_clock: false,
    display_name: 'AirAuto',
  })
}

export function channelOpenResponse(): Buffer {
  return encode('ChannelOpenResponse', { status: 0 })
}

export function mediaConfig(): Buffer {
  return encode('Config', { status: 2, max_unacked: 2, configuration_indices: [0] })
}

export function mediaAck(sessionId: number): Buffer {
  return encode('Ack', { session_id: sessionId, ack: 1 })
}

export function videoFocusNotification(unsolicited = true): Buffer {
  return encode('VideoFocusNotification', { mode: 1, unsolicited })
}

export function pingResponse(timestamp: number | bigint): Buffer {
  return encode('PingResponse', { timestamp })
}

export function byebyeResponse(): Buffer {
  return encode('ByeByeResponse', {})
}

export function sensorResponse(): Buffer {
  return encode('SensorResponse', { status: 0 })
}

export function bindingResponse(): Buffer {
  return encode('BindingResponse', { status: 0 })
}

export function microphoneResponse(sessionId = 1): Buffer {
  return encode('MicrophoneResponse', { status: 0, session_id: sessionId })
}

export interface TouchReportOptions {
  x: number
  y: number
  down: boolean
  width: number
  height: number
}

export function touchReport({ x, y, down, width, height }: TouchReportOptions): Buffer {
  return encode('InputReport', {
    timestamp: BigInt(Date.now()) * 1000000n,
    disp_channel_id: 2,
    touch_event: {
      action: down ? 0 : 1,
      action_index: 0,
      pointer_data: [{
        x: Math.max(0, Math.min(width - 1, Math.round(x * (width - 1)))),
        y: Math.max(0, Math.min(height - 1, Math.round(y * (height - 1)))),
        pointer_id: 0,
      }],
    },
  })
}
