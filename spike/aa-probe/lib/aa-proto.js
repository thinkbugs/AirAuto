'use strict'

const path = require('node:path')
const protobuf = require('protobufjs')

const PROTO_DIR = path.join(__dirname, '..', 'proto')
const PACKAGE = 'com.andrerinas.openheadunit.aap.protocol.proto'

// input.proto and media.proto both declare `MsgType` in the same proto package. The Android
// build compiles each file on its own, so protobuf never sees them together; here they get
// separate roots and lookups fall through.
// Only the root file is listed; imports are resolved relative to it and parsed once.
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

function type(name) {
  for (const root of roots) {
    try {
      return root.lookupType(`${PACKAGE}.${name}`)
    } catch {}
  }
  throw new Error(`proto type not found: ${name}`)
}

function encode(name, object) {
  const t = type(name)
  const error = t.verify(object)
  if (error) throw new Error(`${name} verify failed: ${error}`)
  return Buffer.from(t.encode(t.fromObject(object)).finish())
}

function decode(name, buffer) {
  return type(name).toObject(type(name).decode(buffer))
}

function negotiation() {
  return { width: 1280, height: 720, fps: 30, density: 160 }
}

function serviceDiscoveryResponse({ width, height, fps, density } = negotiation()) {
  const services = [
    {
      id: 1,
      sensor_source_service: { sensors: [{ type: 13 }, { type: 10 }] },
    },
    {
      id: 2,
      media_sink_service: {
        available_type: 3, // MEDIA_CODEC_VIDEO_H264_BP
        audio_type: 0,
        available_while_in_call: true,
        video_configs: [{
          codec_resolution: 2, // _1280x720
          frame_rate: fps >= 60 ? 1 : 2, // _60 : _30
          margin_width: 0,
          margin_height: 0,
          density,
          video_codec_type: 3,
        }],
      },
    },
    {
      id: 3,
      input_source_service: {
        touchscreen: { width, height },
        keycodes_supported: [],
      },
    },
    {
      id: 5,
      media_sink_service: {
        available_type: 1, // PCM
        audio_type: 2, // SYSTEM
        audio_configs: [{ sample_rate: 48000, number_of_bits: 16, number_of_channels: 2 }],
      },
    },
    {
      id: 4,
      media_sink_service: {
        available_type: 1,
        audio_type: 1, // SPEECH
        audio_configs: [{ sample_rate: 16000, number_of_bits: 16, number_of_channels: 1 }],
      },
    },
    {
      id: 6,
      media_sink_service: {
        available_type: 1,
        audio_type: 3, // MEDIA
        audio_configs: [{ sample_rate: 48000, number_of_bits: 16, number_of_channels: 2 }],
      },
    },
    {
      id: 7,
      media_source_service: {
        type: 1,
        audio_config: { sample_rate: 16000, number_of_bits: 16, number_of_channels: 1 },
      },
    },
  ]
  return encode('ServiceDiscoveryResponse', {
    services,
    make: 'WinPlay',
    model: 'WinPlay',
    year: '2026',
    vehicle_id: 'WINPLAY-AA-0001',
    driver_position: 0,
    head_unit_make: 'WinPlay',
    head_unit_model: 'WinPlay AA Probe',
    head_unit_software_build: '0.1.0',
    head_unit_software_version: '0.1.0',
    can_play_native_media_during_vr: false,
    hide_projected_clock: false,
    display_name: 'WinPlay',
  })
}

module.exports = {
  encode,
  decode,
  negotiation,
  serviceDiscoveryResponse,
  encodeServiceDiscovery: serviceDiscoveryResponse,
}
