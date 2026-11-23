'use strict'

// Android Auto head-unit probe. Isolated from WinPlay's engine: it only speaks the
// protocol far enough to verify framing, TLS-in-frame, service discovery and media setup
// against a real phone (AA developer mode "head unit server") or the bundled mock phone.

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const tls = require('node:tls')
const { execFileSync } = require('node:child_process')
const { AaConnection } = require('./lib/connection')
const { CONTROL_MSG, MEDIA_MSG, CHANNEL } = require('./lib/framing')
const proto = require('./lib/aa-proto')

const ARGS = process.argv.slice(2)
const CONNECT_INDEX = ARGS.indexOf('--connect')
const CONNECT_HOST = CONNECT_INDEX >= 0 ? ARGS[CONNECT_INDEX + 1] : null
const PORT = Number(process.env.AA_PORT || (CONNECT_INDEX >= 0 ? ARGS[CONNECT_INDEX + 2] : ARGS[0]) || 5277)
const CERT_DIR = path.join(__dirname, 'certs')
const KEY_FILE = path.join(CERT_DIR, 'key.pem')
const CERT_FILE = path.join(CERT_DIR, 'cert.pem')

function log(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ ts: Date.now(), event, ...data })}\n`)
}

function ensureCertificate() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) return
  fs.mkdirSync(CERT_DIR, { recursive: true })
  log('generate-certificate', { dir: CERT_DIR })
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_FILE, '-out', CERT_FILE,
    '-days', '3650', '-subj', '/CN=WinPlay AA Probe',
  ], { stdio: 'ignore' })
}

const CHANNEL_NAMES = {
  [CHANNEL.CONTROL]: 'control',
  [CHANNEL.SENSOR]: 'sensor',
  [CHANNEL.VIDEO]: 'video',
  [CHANNEL.INPUT]: 'input',
  [CHANNEL.AUDIO1]: 'audio1',
  [CHANNEL.AUDIO2]: 'audio2',
  [CHANNEL.AUDIO]: 'audio0',
  [CHANNEL.MIC]: 'mic',
  [CHANNEL.MEDIA_PLAYBACK]: 'media-playback',
}

function channelName(id) {
  return CHANNEL_NAMES[id] || `channel-${id}`
}

function handleMessage(conn, sessions, message) {
  const { channel, type, payload, flags } = message
  if (channel === CHANNEL.CONTROL) {
    switch (type) {
      case CONTROL_MSG.SERVICE_DISCOVERY_REQUEST: {
        const request = safeDecode('ServiceDiscoveryRequest', payload)
        log('service-discovery-request', { phone: request?.phone_name, brand: request?.phone_brand })
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.SERVICE_DISCOVERY_RESPONSE, proto.serviceDiscoveryResponse())
        log('service-discovery-response', { services: 7 })
        return
      }
      case CONTROL_MSG.CHANNEL_OPEN_REQUEST: {
        const request = safeDecode('ChannelOpenRequest', payload)
        log('channel-open-request', { serviceId: request?.service_id, priority: request?.priority, name: channelName(request?.service_id) })
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.CHANNEL_OPEN_RESPONSE, proto.encode('ChannelOpenResponse', { status: 0 }))
        return
      }
      case CONTROL_MSG.PING_REQUEST: {
        const request = safeDecode('PingRequest', payload)
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.PING_RESPONSE, proto.encode('PingResponse', { timestamp: request?.timestamp ?? 0 }))
        return
      }
      case CONTROL_MSG.NAV_FOCUS_REQUEST:
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.NAV_FOCUS_NOTIFICATION, proto.encode('NavFocusNotification', { focus_type: 1 }))
        return
      case CONTROL_MSG.AUDIO_FOCUS_REQUEST:
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.AUDIO_FOCUS_NOTIFICATION, proto.encode('AudioFocusNotification', { focus_state: 1, unsolicited: true }))
        return
      case CONTROL_MSG.BYEBYE_REQUEST:
        log('byebye-request', {})
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.BYEBYE_RESPONSE, proto.encode('ByeByeResponse', {}))
        setTimeout(() => conn.close(), 200)
        return
      case CONTROL_MSG.VOICE_SESSION_NOTIFICATION:
        log('voice-session', { payloadBytes: payload.length })
        return
      default:
        log('control-message', { type, bytes: payload.length })
        return
    }
  }

  if (channel === CHANNEL.VIDEO) {
    switch (type) {
      case MEDIA_MSG.SETUP: {
        const request = safeDecode('MediaSetupRequest', payload)
        sessions.videoSession = 1
        log('video-setup', { type: request?.type })
        conn.send(channel, MEDIA_MSG.CONFIG, proto.encode('Config', { status: 2, max_unacked: 1, configuration_indices: [0] }))
        conn.send(channel, MEDIA_MSG.VIDEO_FOCUS_NOTIFICATION, proto.encode('VideoFocusNotification', { mode: 1, unsolicited: true }))
        return
      }
      case MEDIA_MSG.START: {
        const request = safeDecode('Start', payload)
        log('video-start', request || {})
        if (request) sessions.videoSession = request.session_id
        return
      }
      case MEDIA_MSG.CODEC_CONFIG: {
        log('video-codec-config', { bytes: payload.length, head: payload.subarray(0, 24).toString('hex') })
        return
      }
      case MEDIA_MSG.DATA: {
        conn.stats.videoFrames++
        if (conn.stats.videoFrames <= 5 || conn.stats.videoFrames % 300 === 0) {
          log('video-frame', { n: conn.stats.videoFrames, bytes: payload.length, flags: `0x${flags.toString(16)}`, declaredTotal: message.declaredTotal })
        }
        if (sessions.videoSession) {
          conn.send(channel, MEDIA_MSG.ACK, proto.encode('Ack', { session_id: sessions.videoSession, ack: 1 }))
        }
        return
      }
      case MEDIA_MSG.STOP:
        log('video-stop', {})
        return
      case MEDIA_MSG.VIDEO_FOCUS_REQUEST: {
        const request = safeDecode('VideoFocusRequestNotification', payload)
        log('video-focus-request', request || {})
        if (request?.mode === 1) {
          conn.send(channel, MEDIA_MSG.VIDEO_FOCUS_NOTIFICATION, proto.encode('VideoFocusNotification', { mode: 1, unsolicited: false }))
        }
        return
      }
      default:
        log('video-message', { type, bytes: payload.length })
        return
    }
  }

  if (channel === CHANNEL.AUDIO || channel === CHANNEL.AUDIO1 || channel === CHANNEL.AUDIO2) {
    switch (type) {
      case MEDIA_MSG.SETUP: {
        const request = safeDecode('MediaSetupRequest', payload)
        log('audio-setup', { channel: channelName(channel), type: request?.type })
        conn.send(channel, MEDIA_MSG.CONFIG, proto.encode('Config', { status: 2, max_unacked: 1, configuration_indices: [0] }))
        return
      }
      case MEDIA_MSG.START: {
        const request = safeDecode('Start', payload)
        log('audio-start', { channel: channelName(channel), ...(request || {}) })
        if (request) sessions[channel] = request.session_id
        return
      }
      case MEDIA_MSG.DATA: {
        conn.stats.audioPackets++
        if (conn.stats.audioPackets <= 5 || conn.stats.audioPackets % 500 === 0) {
          log('audio-packet', { channel: channelName(channel), n: conn.stats.audioPackets, bytes: payload.length })
        }
        return
      }
      case MEDIA_MSG.STOP:
        log('audio-stop', { channel: channelName(channel) })
        return
      default:
        log('audio-message', { channel: channelName(channel), type, bytes: payload.length })
        return
    }
  }

  if (channel === CHANNEL.SENSOR) {
    if (type === 0x8001) {
      const request = safeDecode('SensorRequest', payload)
      log('sensor-start-request', { type: request?.type, period: request?.min_update_period })
      conn.send(channel, 0x8002, proto.encode('SensorResponse', { status: 0 }))
      return
    }
    log('sensor-message', { type, bytes: payload.length })
    return
  }

  if (channel === CHANNEL.INPUT) {
    if (type === 0x8002) {
      log('input-binding-request', { keys: safeDecode('KeyBindingRequest', payload)?.keycodes ?? [] })
      conn.send(channel, 0x8003, proto.encode('BindingResponse', { status: 0 }))
      return
    }
    log('input-report', { type, bytes: payload.length })
    return
  }

  log('unhandled-message', { channel: channelName(channel), type, bytes: payload.length })
}

function safeDecode(name, payload) {
  try {
    return proto.decode(name, payload)
  } catch (error) {
    log('decode-error', { name, message: error.message })
    return null
  }
}

function main() {
  ensureCertificate()
  const secureContext = tls.createSecureContext({
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  })
  const attach = socket => {
    socket.setNoDelay(true)
    const sessions = {}
    log('tcp-connected', { remote: `${socket.remoteAddress}:${socket.remotePort}` })
    const conn = new AaConnection(socket, { isServer: true, secureContext, log })
    conn.on('version-request', () => log('unexpected-version-request', {}))
    conn.on('version', () => log('version-confirmed', {}))
    conn.on('secure', () => conn.sendAuthComplete())
    conn.on('message', message => {
      try {
        handleMessage(conn, sessions, message)
      } catch (error) {
        log('handler-error', { message: error.message })
      }
    })
    conn.on('transport-error', error => log('transport-error', { message: error.message }))
    conn.on('close', () => {
      log('tcp-closed', { stats: conn.stats })
    })
    const ticker = setInterval(() => {
      if (conn.closed) {
        clearInterval(ticker)
        return
      }
      log('stats', { ...conn.stats, secure: conn.secure })
    }, 5000)
    conn.startVersionNegotiation()
    return conn
  }

  let server
  if (CONNECT_HOST) {
    // Developer-mode path: the phone runs its own head unit server on 5277 and we dial it.
    // TLS roles do not follow who dials: the head unit still presents the certificate.
    const socket = net.connect({ host: CONNECT_HOST, port: PORT, allowHalfOpen: true })
    socket.on('connect', () => log('connecting-out', { host: CONNECT_HOST, port: PORT }))
    attach(socket)
    server = { close: callback => { socket.destroy(); callback?.() } }
  } else {
    server = net.createServer({ allowHalfOpen: true }, attach)
    server.on('error', error => {
      log('server-error', { message: error.message })
      process.exitCode = 1
    })
    server.listen(PORT, '0.0.0.0', () => {
      log('listening', { port: PORT })
    })
  }
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
