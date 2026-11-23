import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { EventEmitter } from 'node:events'
import { AaConnection, type AapMessage } from './connection'
import { CHANNEL, CONTROL_MSG, MEDIA_MSG } from './framing'
import { VideoPipeline, type VideoConfig, type VideoAccessUnit } from './video'
import * as messages from './messages'

export interface AapSessionOptions {
  host: string
  port: number
  width: number
  height: number
  fps: number
  density?: number
  log?: (event: string, data?: Record<string, unknown>) => void
}

interface AudioState {
  sessionId: number
  sample: number
  sequence: number
  clockRate: number
  channels: number
}

// Android Auto head-unit session for the developer-mode path: the PC dials the phone's
// head-unit server, but the head unit still presents the TLS certificate.
export class AapSession extends EventEmitter {
  private readonly options: AapSessionOptions
  private readonly video = new VideoPipeline()
  private connection?: AaConnection
  private socket?: net.Socket
  private readonly audio = new Map<number, AudioState>()
  private videoSession = 1
  private started = false
  private closed = false
  private frameCounter = 0
  private lastFrameAt = 0
  private secureTimer?: NodeJS.Timeout
  private connectedFired = false

  readonly stats = { frames: 0, lastFrameAt: 0 }

  constructor(options: AapSessionOptions) {
    super()
    this.options = options
  }

  start(): void {
    if (this.started) return
    this.started = true
    const { host, port } = this.options
    const log = this.options.log ?? (() => {})
    log('aa-connect', { host, port })
    this.emit('status', '正在连接Android Auto')
    const secureContext = tls.createSecureContext({
      key: fs.readFileSync(path.join(__dirname, 'cert', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'cert', 'cert.pem')),
    })
    // Developer-mode head unit servers expect the official DHU client identity; the env
    // toggle keeps the TLS-client path available for future pairing work.
    const tlsClient = process.env.AIRAUTO_AA_TLS_CLIENT === '1'
    this.socket = net.connect({ host, port, allowHalfOpen: true })
    this.socket.setNoDelay(true)
    this.socket.on('connect', () => {
      log('aa-tcp-connected', {})
      const connection = new AaConnection(this.socket!, { isServer: !tlsClient, secureContext: tlsClient ? undefined : secureContext, log })
      this.connection = connection
      connection.on('version', () => this.emit('status', 'Android Auto版本协商完成'))
      connection.on('secure', () => {
        if (this.secureTimer) clearTimeout(this.secureTimer)
        connection.sendAuthComplete()
        this.emit('status', 'Android Auto安全通道已建立')
      })
      connection.on('message', message => this.handleMessage(message))
      connection.on('transport-error', error => this.fail(error.message))
      connection.on('close', () => this.finish('连接已关闭'))
      connection.startVersionNegotiation()
      this.secureTimer = setTimeout(() => this.fail('Android Auto握手超时'), 15000)
    })
    this.socket.on('error', error => this.fail(error.message))
    this.socket.on('close', () => this.finish('连接已断开'))
  }

  stop(): void {
    this.closed = true
    if (this.secureTimer) clearTimeout(this.secureTimer)
    this.connection?.close()
    this.socket?.destroy()
  }

  touch(x: number, y: number, down: boolean): void {
    if (!this.connection || this.closed) return
    const payload = messages.touchReport({ x, y, down, width: this.options.width, height: this.options.height })
    this.connection.send(CHANNEL.INPUT, 0x8001, payload)
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.emit('error', reason)
    this.stop()
    this.emit('ended', reason)
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.secureTimer) clearTimeout(this.secureTimer)
    this.emit('ended', reason)
  }

  private handleMessage(message: AapMessage): void {
    const connection = this.connection
    if (!connection) return
    const { channel, type, payload, flags } = message
    if (channel === CHANNEL.CONTROL) {
      switch (type) {
        case CONTROL_MSG.SERVICE_DISCOVERY_REQUEST: {
          const request = this.decode('ServiceDiscoveryRequest', payload)
          this.emit('status', '已收到Android Auto服务发现')
          this.options.log?.('aa-discovery', { phone: request?.phone_name, brand: request?.phone_brand })
          connection.send(CHANNEL.CONTROL, CONTROL_MSG.SERVICE_DISCOVERY_RESPONSE, messages.serviceDiscoveryResponse({
            width: this.options.width,
            height: this.options.height,
            fps: this.options.fps,
            density: this.options.density ?? 160,
          }))
          return
        }
        case CONTROL_MSG.CHANNEL_OPEN_REQUEST: {
          connection.send(CHANNEL.CONTROL, CONTROL_MSG.CHANNEL_OPEN_RESPONSE, messages.channelOpenResponse())
          return
        }
        case CONTROL_MSG.PING_REQUEST: {
          const request = this.decode('PingRequest', payload)
          connection.send(CHANNEL.CONTROL, CONTROL_MSG.PING_RESPONSE, messages.pingResponse(request?.timestamp ?? 0))
          return
        }
        case CONTROL_MSG.NAV_FOCUS_REQUEST:
          return
        case CONTROL_MSG.AUDIO_FOCUS_REQUEST:
          connection.send(CHANNEL.CONTROL, CONTROL_MSG.AUDIO_FOCUS_NOTIFICATION, encodeAudioFocus())
          return
        case CONTROL_MSG.BYEBYE_REQUEST:
          connection.send(CHANNEL.CONTROL, CONTROL_MSG.BYEBYE_RESPONSE, messages.byebyeResponse())
          setImmediate(() => this.finish('手机已断开'))
          return
        default:
          return
      }
    }

    if (channel === CHANNEL.VIDEO) {
      if (type === null) {
        this.pushVideoFrame(payload, flags, null)
        return
      }
      switch (type) {
        case MEDIA_MSG.SETUP:
          this.videoSession = 1
          connection.send(channel, MEDIA_MSG.CONFIG, messages.mediaConfig())
          connection.send(channel, MEDIA_MSG.VIDEO_FOCUS_NOTIFICATION, messages.videoFocusNotification())
          return
        case MEDIA_MSG.START: {
          const request = this.decode('Start', payload)
          if (request?.session_id) this.videoSession = request.session_id
          return
        }
        case MEDIA_MSG.CODEC_CONFIG: {
          const configured = this.video.configure(payload)
          if (configured) {
            this.emit('video-config', configured)
            this.emit('status', '已收到Android Auto视频配置')
          }
          return
        }
        case MEDIA_MSG.DATA:
          this.pushVideoFrame(payload, flags, null)
          return
        case MEDIA_MSG.VIDEO_FOCUS_REQUEST: {
          const request = this.decode('VideoFocusRequestNotification', payload)
          if (request?.mode === 1) connection.send(channel, MEDIA_MSG.VIDEO_FOCUS_NOTIFICATION, messages.videoFocusNotification(false))
          return
        }
        default:
          return
      }
    }

    if (channel === CHANNEL.AUDIO || channel === CHANNEL.AUDIO1 || channel === CHANNEL.AUDIO2) {
      if (type === null) {
        this.handleAudioData(channel, payload, flags)
        return
      }
      switch (type) {
        case MEDIA_MSG.SETUP:
          connection.send(channel, MEDIA_MSG.CONFIG, messages.mediaConfig())
          return
        case MEDIA_MSG.START: {
          const request = this.decode('Start', payload)
          const rate = channel === CHANNEL.AUDIO1 ? 16000 : 48000
          const channels = channel === CHANNEL.AUDIO1 ? 1 : 2
          this.audio.set(channel, {
            sessionId: request?.session_id ?? 1,
            sample: 0,
            sequence: 0,
            clockRate: rate,
            channels,
          })
          this.emit('audio-config', {
            id: channel,
            opts: { codec: 'pcm', clockRate: rate, channels, latencyMs: 60, realtime: true, media: channel === CHANNEL.AUDIO },
          })
          return
        }
        case MEDIA_MSG.DATA:
          this.handleAudioData(channel, payload, flags)
          return
        default:
          return
      }
    }

    if (channel === CHANNEL.SENSOR && type === 0x8001) {
      connection.send(channel, 0x8002, messages.sensorResponse())
      return
    }
    if (channel === CHANNEL.INPUT && type === 0x8002) {
      connection.send(channel, 0x8003, messages.bindingResponse())
      return
    }
    if (channel === CHANNEL.MIC && type === MEDIA_MSG.MICROPHONE_REQUEST) {
      const request = this.decode('MicrophoneRequest', payload)
      if (request?.open) connection.send(channel, MEDIA_MSG.MICROPHONE_RESPONSE, messages.microphoneResponse())
      return
    }
  }

  private pushVideoFrame(payload: Buffer, flags: number, _declared: number | null): void {
    const frame = this.video.push(payload, flags)
    if (!frame) return
    this.frameCounter++
    this.lastFrameAt = Date.now()
    this.stats.frames++
    this.stats.lastFrameAt = this.lastFrameAt
    const timestamp = frame.timestamp ? Number(frame.timestamp) : this.frameCounter * 33333
    this.emit('video-frame', {
      data: frame.data,
      timestamp: Number.isFinite(timestamp) ? timestamp : this.frameCounter * 33333,
      keyframe: frame.keyframe,
    })
    if (!this.connectedFired) {
      this.connectedFired = true
      this.emit('connected')
    }
    this.connection?.send(CHANNEL.VIDEO, MEDIA_MSG.ACK, messages.mediaAck(this.videoSession))
  }

  private handleAudioData(channel: number, payload: Buffer, flags: number): void {
    const state = this.audio.get(channel)
    if (!state || !payload.length) return
    // Media data carries an 8-byte timestamp before the PCM payload.
    const pcm = payload.length > 8 && flags & 0x01 ? payload.subarray(8) : payload
    if (pcm.length < 2) return
    state.sequence = (state.sequence + 1) & 0xffff
    const samples = Math.floor(pcm.length / 2 / state.channels)
    this.emit('audio', { id: channel, sample: state.sample, sequence: state.sequence, data: pcm })
    state.sample += samples
  }

  private decode<T = Record<string, any>>(name: string, payload: Buffer): T | null {
    try {
      return messages.decode<T>(name, payload)
    } catch {
      return null
    }
  }
}

function encodeAudioFocus(): Buffer {
  return messages.encode('AudioFocusNotification', { focus_state: 1, unsolicited: true })
}
