'use strict'

// Minimal phone-side counterpart used by the self-test. It is not a phone: it only proves
// that the head-unit path (version exchange, TLS-over-frames, service discovery, channel
// open, media setup, codec config and a data frame) round-trips end to end.
//
// Default: dials the head unit (wireless direction).
// --listen: behaves like the phone-side "head unit server" so `server.js --connect` can be
// exercised the way Android Auto's developer mode exposes it.

const fs = require('node:fs')
const net = require('node:net')
const { AaConnection } = require('./lib/connection')
const { CONTROL_MSG, MEDIA_MSG, CHANNEL } = require('./lib/framing')
const { splitAnnexB } = require('./lib/nalu')
const proto = require('./lib/aa-proto')

const ARGS = process.argv.slice(2)
const LISTEN = ARGS.includes('--listen')
const SAMPLE_INDEX = ARGS.indexOf('--sample')
const SAMPLE_FILE = SAMPLE_INDEX >= 0 ? ARGS[SAMPLE_INDEX + 1] : null
const PORT = Number(process.env.AA_PORT || ARGS.find(arg => /^\d+$/.test(arg)) || 5277)

function loadSample(file) {
  const nals = splitAnnexB(fs.readFileSync(file))
  const configNals = []
  const accessUnits = []
  let pending = []
  for (const nal of nals) {
    const type = nal[0] & 0x1f
    if (type === 7 || type === 8) {
      configNals.push(nal)
      continue
    }
    if (type === 6) {
      pending.push(nal)
      continue
    }
    if (type === 1 || type === 5) {
      accessUnits.push([...pending, nal])
      pending = []
    }
  }
  const annexB = list => Buffer.concat(list.map(nal => Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])))
  return { config: annexB(configNals), frames: accessUnits.map(annexB) }
}

const sample = SAMPLE_FILE ? loadSample(SAMPLE_FILE) : null
const TIMEOUT_MS = Number(process.env.AA_MOCK_TIMEOUT || 15000)
const log = (event, data = {}) => process.stdout.write(`${JSON.stringify({ ts: Date.now(), side: 'phone', event, ...data })}\n`)

function attach(socket) {
  socket.setNoDelay(true)
  const conn = new AaConnection(socket, { isServer: false, log })
  let finished = false
  // A sample stream is meant to keep running so a preview can be opened at any time.
  const timer = sample ? null : setTimeout(() => {
    log('timeout')
    process.exit(1)
  }, TIMEOUT_MS)

  function finish(code, reason) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (streamTimer) {
      clearInterval(streamTimer)
      streamTimer = null
    }
    log('finish', { code, reason })
    conn.close()
    setTimeout(() => process.exit(code), 100)
  }

  conn.on('version-request', () => {
    log('send-version-response')
    conn.sendPlain(CHANNEL.CONTROL, CONTROL_MSG.VERSION_RESPONSE, Buffer.from([0, 1, 0, 0]))
    conn.startTls()
  })

  conn.on('secure', () => {
    log('send-service-discovery-request')
    conn.send(CHANNEL.CONTROL, CONTROL_MSG.SERVICE_DISCOVERY_REQUEST, proto.encode('ServiceDiscoveryRequest', {
      phone_name: 'Mock Phone',
      phone_brand: 'AirAuto Spike',
    }))
  })

  conn.on('message', message => {
    try {
      handle(message, conn, finish)
    } catch (error) {
      log('handle-error', { message: error.message })
    }
  })

  conn.on('transport-error', error => {
    log('transport-error', { message: error.message })
    finish(1, 'transport-error')
  })
  conn.on('close', () => {
    if (!finished) finish(1, 'closed-early')
  })
  return conn
}

let servicesOpened = false
let streamTimer = null
let frameIndex = 0

// AA fragments anything that does not fit one TLS record. The first fragment carries the
// message type plus the 8-byte timestamp; middle/last fragments are raw continuation bytes
// with no type of their own (flags 0x09 / 0x08 / 0x0a).
function sendAccessUnit(conn, frame) {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigUInt64BE(BigInt(frameIndex * 33333))
  if (frame.length <= 12000) {
    conn.send(CHANNEL.VIDEO, MEDIA_MSG.DATA, Buffer.concat([timestamp, frame]), 0x0b)
    return
  }
  let offset = 0
  let first = true
  while (offset < frame.length) {
    const chunk = frame.subarray(offset, Math.min(offset + 12000, frame.length))
    offset += chunk.length
    const last = offset >= frame.length
    if (first) {
      conn.send(CHANNEL.VIDEO, MEDIA_MSG.DATA, Buffer.concat([timestamp, chunk]), last ? 0x0b : 0x09, frame.length)
      first = false
    } else {
      conn.send(CHANNEL.VIDEO, null, chunk, last ? 0x0a : 0x08)
    }
  }
}

function startSampleStream(conn) {
  if (streamTimer) return
  log('sample-stream', { frames: sample.frames.length, fps: 30 })
  streamTimer = setInterval(() => {
    sendAccessUnit(conn, sample.frames[frameIndex++ % sample.frames.length])
  }, 33)
}

function handle({ channel, type, payload }, conn, finish) {
  if (channel === CHANNEL.CONTROL) {
    if (type === CONTROL_MSG.SERVICE_DISCOVERY_RESPONSE) {
      const response = proto.decode('ServiceDiscoveryResponse', payload)
      const ids = response.services.map(service => service.id)
      log('service-discovery-response', { ids, make: response.make, model: response.model })
      if (!servicesOpened) {
        servicesOpened = true
        conn.send(CHANNEL.CONTROL, CONTROL_MSG.CHANNEL_OPEN_REQUEST, proto.encode('ChannelOpenRequest', { priority: 0, service_id: CHANNEL.VIDEO }))
      }
      return
    }
    if (type === CONTROL_MSG.CHANNEL_OPEN_RESPONSE) {
      log('channel-open-response', { status: proto.decode('ChannelOpenResponse', payload).status })
      conn.send(CHANNEL.VIDEO, MEDIA_MSG.SETUP, proto.encode('MediaSetupRequest', { type: 3 }))
      return
    }
    if (type === CONTROL_MSG.PING_REQUEST) {
      conn.send(CHANNEL.CONTROL, CONTROL_MSG.PING_RESPONSE, proto.encode('PingResponse', { timestamp: proto.decode('PingRequest', payload).timestamp }))
      return
    }
    if (type === CONTROL_MSG.BYEBYE_RESPONSE) {
      finish(0, 'byebye-acknowledged')
      return
    }
    return
  }

  if (channel === CHANNEL.VIDEO) {
    if (type === MEDIA_MSG.CONFIG) {
      const config = proto.decode('Config', payload)
      log('media-config', config)
      conn.send(CHANNEL.VIDEO, MEDIA_MSG.START, proto.encode('Start', { session_id: 1, configuration_index: 0 }))
      conn.send(CHANNEL.VIDEO, MEDIA_MSG.CODEC_CONFIG, sample
        ? sample.config
        : Buffer.from('000000016742001e95a8280f0044fcb80000000168ce3c80', 'hex'))
      return
    }
    if (type === MEDIA_MSG.VIDEO_FOCUS_NOTIFICATION) {
      log('video-focus-notification', proto.decode('VideoFocusNotification', payload))
      if (sample) {
        startSampleStream(conn)
        return
      }
      const timestamp = Buffer.alloc(8)
      timestamp.writeBigUInt64BE(123456789n)
      const idr = Buffer.from('0000000165b80410ffff', 'hex')
      conn.send(CHANNEL.VIDEO, MEDIA_MSG.DATA, Buffer.concat([timestamp, idr]))
      return
    }
    if (type === MEDIA_MSG.ACK) {
      log('media-ack', proto.decode('Ack', payload))
      if (sample) return
      conn.send(CHANNEL.CONTROL, CONTROL_MSG.BYEBYE_REQUEST, proto.encode('ByeByeRequest', { reason: 1 }))
      return
    }
  }
}

if (LISTEN) {
  net.createServer({ allowHalfOpen: true }, socket => {
    log('phone-listening-accept', { remote: `${socket.remoteAddress}:${socket.remotePort}` })
    attach(socket)
  }).listen(PORT, '0.0.0.0', () => log('phone-listening', { port: PORT }))
} else {
  const socket = net.connect({ host: '127.0.0.1', port: PORT, allowHalfOpen: true })
  attach(socket)
}
