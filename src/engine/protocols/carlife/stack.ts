import dgram from 'node:dgram'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import {
  ACTION_DOWN,
  ACTION_MOVE,
  ACTION_UP,
  CHANNEL_AUDIO,
  CHANNEL_CMD,
  CHANNEL_DATA,
  CHANNEL_TTS,
  CHANNEL_TOUCH,
  CHANNEL_VIDEO,
  CHANNEL_VR,
  CMD,
  CONNECT_STATUS_WIFI,
  PORTS,
  UDP_DISCOVERY_PORT,
  ChannelParser,
  packMessage,
  type CarLifeMessage,
} from './constants'
import * as messages from './messages'
import { CarLifeVideo } from './video'

export interface CarLifeOptions {
  host?: string
  width: number
  height: number
  fps: number
  log?: (event: string, data?: Record<string, unknown>) => void
}

// CarLife+ head-unit session: the car is the TCP client. Wireless discovery listens for the
// phone's UDP broadcast on 7999; a host can be supplied to skip discovery.
export class CarLifeSession extends EventEmitter {
  private readonly options: CarLifeOptions
  private readonly sockets = new Map<number, net.Socket>()
  private readonly parsers = new Map<number, ChannelParser>()
  private readonly video = new CarLifeVideo()
  private udp?: dgram.Socket
  private heartbeat?: NodeJS.Timeout
  private versionTimer?: NodeJS.Timeout
  private discoveryTimer?: NodeJS.Timeout
  private featureTimer?: NodeJS.Timeout
  private closed = false
  private started = false
  private versionConfirmed = false
  private featureAcked = false
  private featureSent = false
  private encoderInitSent = false
  private encoderStartSent = false
  private lastDown = false
  private frameCounter = 0
  private width: number
  private height: number
  private fps: number

  constructor(options: CarLifeOptions) {
    super()
    this.options = options
    this.width = options.width
    this.height = options.height
    this.fps = options.fps
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.options.host) {
      this.connect(this.options.host)
      return
    }
    this.emit('status', '正在局域网发现 CarLife')
    this.udp = dgram.createSocket('udp4')
    this.udp.on('error', error => this.fail(error.message))
    this.udp.on('message', (data, remote) => {
      this.options.log?.('carlife-discovery', { from: remote.address, bytes: data.length })
      this.udp?.close()
      this.udp = undefined
      if (this.discoveryTimer) clearTimeout(this.discoveryTimer)
      this.connect(remote.address)
    })
    this.udp.bind(UDP_DISCOVERY_PORT, () => {
      this.emit('status', '等待手机 CarLife 广播（UDP 7999）')
    })
    this.discoveryTimer = setTimeout(() => {
      if (!this.sockets.size) this.fail('未发现 CarLife 手机，请确认手机与电脑同一网络并打开 CarLife')
    }, 45000)
  }

  private async connect(host: string): Promise<void> {
    try {
      this.emit('status', '正在连接 CarLife 通道')
      await this.connectChannel(CHANNEL_CMD, host)
      // Auxiliary channels are best-effort; the control channel is the lifeline.
      for (const channel of [CHANNEL_VIDEO, CHANNEL_TOUCH, CHANNEL_DATA, CHANNEL_AUDIO, CHANNEL_TTS, CHANNEL_VR]) {
        this.connectChannel(channel, host).catch(error => this.options.log?.('carlife-channel-failed', { channel, message: (error as Error).message }))
      }
      this.startVersionLoop()
      this.emit('status', 'CarLife 控制通道已连接')
    } catch (error) {
      this.fail(`CarLife 控制通道连接失败：${(error as Error).message}`)
    }
  }

  private connectChannel(channel: number, host: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port: PORTS[channel], allowHalfOpen: true })
      socket.setNoDelay(true)
      const onError = (error: Error) => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        socket.on('error', error => this.options.log?.('carlife-socket-error', { channel, message: error.message }))
        this.sockets.set(channel, socket)
        const parser = new ChannelParser(channel)
        this.parsers.set(channel, parser)
        socket.on('data', chunk => {
          let parsed: CarLifeMessage[]
          try {
            parsed = parser.push(chunk)
          } catch (error) {
            this.options.log?.('carlife-framing-error', { channel, message: (error as Error).message })
            return
          }
          for (const message of parsed) this.handleMessage(channel, message)
        })
        socket.on('close', () => {
          this.sockets.delete(channel)
          if (channel === CHANNEL_CMD) this.finish('CarLife 控制通道已断开')
        })
        resolve(socket)
      })
    })
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.versionTimer) clearInterval(this.versionTimer)
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer)
    if (this.featureTimer) clearTimeout(this.featureTimer)
    try { this.udp?.close() } catch {}
    for (const socket of this.sockets.values()) socket.destroy()
    this.sockets.clear()
  }

  touch(x: number, y: number, down: boolean): void {
    const socket = this.sockets.get(CHANNEL_TOUCH)
    if (!socket || this.closed) return
    const action = down ? (this.lastDown ? ACTION_MOVE : ACTION_DOWN) : ACTION_UP
    this.lastDown = down
    const px = Math.max(0, Math.min(this.width - 1, Math.round(x * (this.width - 1))))
    const py = Math.max(0, Math.min(this.height - 1, Math.round(y * (this.height - 1))))
    socket.write(packMessage(CHANNEL_TOUCH, CMD.TOUCH_ACTION, messages.touchAction(action, px, py)))
  }

  pressKey(keycode: number): void {
    this.sockets.get(CHANNEL_TOUCH)?.write(packMessage(CHANNEL_TOUCH, CMD.HARD_KEY_CODE, messages.hardKey(keycode)))
  }

  private sendCmd(serviceType: number, payload: Buffer = Buffer.alloc(0)): void {
    const socket = this.sockets.get(CHANNEL_CMD)
    if (socket && !this.closed) socket.write(packMessage(CHANNEL_CMD, serviceType, payload))
  }

  private startVersionLoop(): void {
    const send = () => {
      if (this.closed || this.versionConfirmed) return
      // 3.0 is what the shipping Honor/Baidu phone engines answer; 4.0 is ignored.
      this.sendCmd(CMD.HU_PROTOCOL_VERSION, messages.protocolVersion(3, 0))
    }
    send()
    this.versionTimer = setInterval(send, 1500)
  }

  private pushFeatureConfig(): void {
    if (this.closed || this.featureSent) return
    this.featureSent = true
    this.sendCmd(CMD.HU_FEATURE_CONFIG_RESPONSE, messages.featureConfigList(CONNECT_STATUS_WIFI))
    // Some engines never ACK 98386 (65570); don't let that block the encoder init.
    this.featureTimer = setTimeout(() => {
      this.featureTimer = undefined
      if (!this.closed && !this.featureAcked) this.sendEncoderInit()
    }, 1500)
  }

  private sendEncoderInit(): void {
    if (this.closed || !this.versionConfirmed || this.encoderInitSent) return
    this.encoderInitSent = true
    this.sendCmd(CMD.HU_VIDEO_ENCODER_INIT, messages.videoEncoderInfo(this.width, this.height, this.fps))
    this.emit('status', 'CarLife 特征配置完成，协商视频参数')
  }

  private handleMessage(channel: number, message: CarLifeMessage): void {
    if (channel === CHANNEL_VIDEO) {
      if (message.serviceType !== CMD.VIDEO_DATA || !message.payload.length) return
      const result = this.video.push(message.payload)
      if (result.config) this.emit('video-config', result.config)
      if (result.frame) {
        this.frameCounter++
        this.emit('video-frame', {
          data: result.frame.data,
          keyframe: result.frame.keyframe,
          timestamp: this.frameCounter * Math.round(1e6 / Math.max(this.fps, 1)),
        })
        if (this.frameCounter === 1) {
          this.emit('connected')
          this.emit('status', '正在接收 CarLife 视频')
        }
      }
      return
    }
    if (channel !== CHANNEL_CMD) return

    switch (message.serviceType) {
      // Real-engine order (verified against CarLife+ 8.8.5 on a phone):
      // 98305 v3.0 -> 65538 -> 98343 stats -> 65540 MD_INFO -> 98307 HU_INFO
      // -> 98386 feature -> 65570 ack -> 98311 encoder init -> 65544 -> 98313 start.
      case CMD.PROTOCOL_VERSION_MATCH_STATUS: {
        const status = this.decode('CarlifeProtocolVersionMatchStatus', message.payload)
        if (status && Number(status.matchStatus) === 1 && !this.versionConfirmed) {
          this.versionConfirmed = true
          if (this.versionTimer) clearInterval(this.versionTimer)
          this.emit('status', 'CarLife 版本协商完成')
          this.sendCmd(CMD.HU_STATISTICAL_INFO, messages.statisticsInfo())
          this.startHeartbeat()
        }
        return
      }
      case CMD.MD_INFO: {
        const device = this.decode('CarlifeDeviceInfo', message.payload)
        this.options.log?.('carlife-phone-info', { brand: device?.brand, model: device?.model, release: device?.release })
        this.sendCmd(CMD.HU_INFO, messages.deviceInfo({ width: this.width, height: this.height }))
        this.emit('status', '已交换 CarLife 设备信息')
        // The phone waits for us to drive the negotiation; push feature config without
        // waiting for its 65617 request.
        const timer = setTimeout(() => this.pushFeatureConfig(), 300)
        if (this.featureTimer) clearTimeout(this.featureTimer)
        this.featureTimer = timer
        return
      }
      case CMD.MD_FEATURE_CONFIG_DONE: {
        this.featureAcked = true
        if (this.featureTimer) clearTimeout(this.featureTimer)
        this.featureTimer = undefined
        this.sendEncoderInit()
        return
      }
      case CMD.MD_FEATURE_CONFIG_REQUEST: {
        if (!this.featureAcked) {
          this.featureSent = false
          this.pushFeatureConfig()
        } else {
          this.sendCmd(CMD.HU_FEATURE_CONFIG_RESPONSE, messages.featureConfigList(CONNECT_STATUS_WIFI))
        }
        return
      }
      case CMD.MD_MODULE_STATUS: {
        const list = this.decode<{ moduleStatus?: Array<{ moduleID: number; statusID: number }> }>('CarlifeModuleStatusList', message.payload)
        const modules = list?.moduleStatus ?? []
        if (!modules.length) return
        this.sendCmd(CMD.HU_MODULE_CONTROL, messages.moduleControl(modules))
        this.options.log?.('carlife-module-status', { modules })
        return
      }
      case CMD.MD_AUTHEN_RESULT: {
        // Not part of the wireless phone flow, but harmless to acknowledge.
        this.sendCmd(CMD.HU_AUTHEN_RESULT_98380)
        return
      }
      case CMD.VIDEO_ENCODER_INIT: {
        const encoder = this.decode('CarlifeVideoEncoderInfo', message.payload)
        if (encoder && Number(encoder.width) > 0) this.width = Number(encoder.width)
        if (encoder && Number(encoder.height) > 0) this.height = Number(encoder.height)
        if (encoder && Number(encoder.frameRate) > 0) this.fps = Number(encoder.frameRate)
        if (!this.encoderStartSent) {
          this.encoderStartSent = true
          this.sendCmd(CMD.VIDEO_ENCODER_START)
        }
        this.emit('video-size', { width: this.width, height: this.height })
        this.options.log?.('carlife-video-params', { width: this.width, height: this.height, fps: this.fps })
        return
      }
      case CMD.VIDEO_ENCODER_INIT_DONE:
        return
      case CMD.MD_EXIT:
        this.finish('手机已退出 CarLife')
        return
      default:
        return
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      if (this.closed) return
      this.sendCmd(CMD.HU_HEARTBEAT)
    }, 1000)
  }

  private decode<T = Record<string, any>>(name: string, payload: Buffer): T | null {
    try {
      return messages.decode<T>(name, payload)
    } catch {
      return null
    }
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.emit('error', reason)
    this.stop()
    this.emit('ended', reason)
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.stop()
    this.emit('ended', reason)
  }
}
