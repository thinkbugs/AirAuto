import protobuf from 'protobufjs'

// Field numbers follow the Baidu CarLife vehicle-side protocol (see the public V2.1.1
// integration guide and open vehicle-side references). proto3 is used because the wire
// format on the wire is the same and optional defaults are acceptable for a head unit.
const root = protobuf.Root.fromJSON({
  nested: {
    carlife: {
      nested: {
        CarlifeProtocolVersion: {
          fields: {
            majorVersion: { type: 'int32', id: 1 },
            minorVersion: { type: 'int32', id: 2 },
          },
        },
        CarlifeProtocolVersionMatchStatus: {
          fields: {
            matchStatus: { type: 'int32', id: 1 },
            carlifeProtocolVersion: { type: 'int32', id: 2 },
          },
        },
        CarlifeDeviceInfo: {
          fields: {
            os: { type: 'string', id: 1 },
            board: { type: 'string', id: 2 },
            bootloader: { type: 'string', id: 3 },
            brand: { type: 'string', id: 4 },
            cpuAbi: { type: 'string', id: 5 },
            cpuAbi2: { type: 'string', id: 6 },
            device: { type: 'string', id: 7 },
            display: { type: 'string', id: 8 },
            fingerprint: { type: 'string', id: 9 },
            hardware: { type: 'string', id: 10 },
            host: { type: 'string', id: 11 },
            cid: { type: 'string', id: 12 },
            manufacturer: { type: 'string', id: 13 },
            model: { type: 'string', id: 14 },
            product: { type: 'string', id: 15 },
            serial: { type: 'string', id: 16 },
            codename: { type: 'string', id: 17 },
            incremental: { type: 'string', id: 18 },
            release: { type: 'string', id: 19 },
            sdk: { type: 'string', id: 20 },
            sdkInt: { type: 'int32', id: 21 },
            carlifeversion: { type: 'string', id: 22 },
            btaddress: { type: 'string', id: 23 },
          },
        },
        CarlifeStatisticsInfo: {
          fields: {
            cuid: { type: 'string', id: 1 },
            versionName: { type: 'string', id: 2 },
            versionCode: { type: 'int32', id: 3 },
            channel: { type: 'string', id: 4 },
            connectCount: { type: 'int32', id: 5 },
            connectSuccessCount: { type: 'int32', id: 6 },
            connectTime: { type: 'int32', id: 7 },
            crashCycle: { type: 'string', id: 8 },
          },
        },
        CarlifeAuthenResult: {
          fields: { authenResult: { type: 'bool', id: 1 } },
        },
        CarlifeFeatureConfig: {
          fields: {
            key: { type: 'string', id: 1 },
            value: { type: 'int32', id: 2 },
          },
        },
        CarlifeFeatureConfigList: {
          fields: {
            cnt: { type: 'int32', id: 1 },
            featureConfig: { type: 'CarlifeFeatureConfig', id: 2, rule: 'repeated' },
            huBtAudioSupport: { type: 'bool', id: 3 },
            huBtName: { type: 'string', id: 4 },
            huBtMAC: { type: 'string', id: 5 },
          },
        },
        CarlifeVideoEncoderInfo: {
          fields: {
            width: { type: 'int32', id: 1 },
            height: { type: 'int32', id: 2 },
            frameRate: { type: 'int32', id: 3 },
          },
        },
        CarlifeTouchAction: {
          fields: {
            action: { type: 'int32', id: 1 },
            x: { type: 'int32', id: 2 },
            y: { type: 'int32', id: 3 },
            pointerx: { type: 'int32', id: 4 },
            pointery: { type: 'int32', id: 5 },
          },
        },
        CarlifeCarHardKeyCode: {
          fields: { keycode: { type: 'int32', id: 1 } },
        },
        CarlifeModuleStatus: {
          fields: {
            moduleID: { type: 'int32', id: 1 },
            statusID: { type: 'int32', id: 2 },
          },
        },
        CarlifeModuleStatusList: {
          fields: {
            cnt: { type: 'int32', id: 1 },
            moduleStatus: { type: 'CarlifeModuleStatus', id: 2, rule: 'repeated' },
          },
        },
      },
    },
  },
})

const PACKAGE = 'carlife'

export function encode(name: string, value: object): Buffer {
  const type = root.lookupType(`${PACKAGE}.${name}`)
  return Buffer.from(type.encode(type.fromObject(value)).finish())
}

export function decode<T = Record<string, any>>(name: string, payload: Buffer): T {
  const type = root.lookupType(`${PACKAGE}.${name}`)
  return type.toObject(type.decode(payload)) as T
}

// The phone's schema is proto2 with required fields; protobufjs would omit a zero
// minorVersion and the engine then never answers within its 5s window.
export function protocolVersion(major = 3, minor = 0): Buffer {
  return Buffer.from([0x08, major & 0x7f, 0x10, minor & 0x7f])
}

// Only fields 1-8 are sent: the phone parses this with a typed protobuf, and a wrong
// type in a higher field number aborts the session silently on real devices.
export function deviceInfo(options: { width: number; height: number; model?: string }): Buffer {
  return encode('CarlifeDeviceInfo', {
    os: 'Android',
    board: 'universal',
    bootloader: 'unknown',
    brand: 'baidu',
    cpuAbi: 'arm64-v8a',
    cpuAbi2: 'arm64-v8a',
    device: options.model ?? 'AirAutoVehicle',
    display: `${options.width}x${options.height}`,
  })
}

export function statisticsInfo(): Buffer {
  return encode('CarlifeStatisticsInfo', {
    channel: '20029999',
    cuid: '12345678',
    versionCode: 16,
    versionName: '4.0.0',
    connectCount: 0,
    connectSuccessCount: 0,
    connectTime: 0,
    crashCycle: '',
  })
}

export function featureConfigList(connectType: number): Buffer {
  const featureConfig = [
    { key: 'I_FRAME_INTERVAL', value: 20 },
    { key: 'CONNECT_TYPE', value: connectType },
    { key: 'DISABLE_RESOLUTION_OPTION', value: 1 },
    { key: 'CONTENT_ENCRYPTION', value: 0 },
    { key: 'MEDIA_LYRIC_SUPPORT', value: 1 },
  ]
  return encode('CarlifeFeatureConfigList', {
    cnt: featureConfig.length,
    featureConfig,
    huBtAudioSupport: false,
    huBtName: 'AirAuto',
    huBtMAC: '00:11:22:33:44:55',
  })
}

// Modules 4 (VR) and 6 (mic) report 0 when idle; echoing those back as 1 hijacks the
// phone's voice state. Every other idle module is enabled as CarLife expects.
export function moduleControl(modules: Array<{ moduleID: number; statusID: number }>): Buffer {
  const enabled = modules
    .filter(item => !(Number(item.statusID) === 0 && (Number(item.moduleID) === 4 || Number(item.moduleID) === 6)))
    .map(item => ({ moduleID: Number(item.moduleID), statusID: 1 }))
  return encode('CarlifeModuleStatusList', { cnt: enabled.length, moduleStatus: enabled })
}

export function videoEncoderInfo(width: number, height: number, frameRate: number): Buffer {
  return encode('CarlifeVideoEncoderInfo', { width, height, frameRate })
}

export function touchAction(action: number, x: number, y: number): Buffer {
  return encode('CarlifeTouchAction', { action, x, y, pointerx: 0, pointery: 0 })
}

export function hardKey(keycode: number): Buffer {
  return encode('CarlifeCarHardKeyCode', { keycode })
}
