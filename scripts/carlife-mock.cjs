// Dev-only CarLife phone simulator for the engine self-test. Speaks the vehicle-side
// handshake and streams H.264 access units from the AA probe sample.
'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const root = path.join(__dirname, '..')
const carlife = require(path.join(root, 'build', 'engine', 'protocols', 'carlife', 'constants.js'))
const messages = require(path.join(root, 'build', 'engine', 'protocols', 'carlife', 'messages.js'))
const { splitAnnexB } = require(path.join(root, 'build', 'engine', 'protocols', 'aa', 'nalu.js'))

const sample = path.join(root, 'spike', 'aa-probe', 'sample', 'testsrc-small.h264')
const log = (event, data = {}) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n')

function loadSample() {
  if (!fs.existsSync(sample)) return { config: Buffer.alloc(0), units: [] }
  const nals = splitAnnexB(fs.readFileSync(sample))
  const configNals = nals.filter(nal => [7, 8].includes(nal[0] & 0x1f))
  const units = []
  let pending = []
  for (const nal of nals) {
    const type = nal[0] & 0x1f
    if (type === 7 || type === 8) continue
    pending.push(nal)
    if (type === 1 || type === 5) {
      units.push(Buffer.concat(pending.map(item => Buffer.concat([Buffer.from([0, 0, 0, 1]), item]))))
      pending = []
    }
  }
  const annexB = list => Buffer.concat(list.map(nal => Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])))
  return { config: annexB(configNals), units }
}

const sampleData = loadSample()
const units = sampleData.units
const configPacket = sampleData.config
const sockets = new Map()
const parsers = new Map()
let videoTimer
let videoNegotiated = false
let versionMatched = false

function send(channel, serviceType, payload = Buffer.alloc(0)) {
  const socket = sockets.get(channel)
  if (!socket) return
  socket.write(carlife.packMessage(channel, serviceType, payload))
}

function streamVideo() {
  if (videoTimer || !units.length) return
  let index = 0
  if (configPacket.length) send(carlife.CHANNEL_VIDEO, carlife.CMD.VIDEO_DATA, configPacket)
  videoTimer = setInterval(() => {
    const unit = units[index++ % units.length]
    send(carlife.CHANNEL_VIDEO, carlife.CMD.VIDEO_DATA, unit)
  }, 33)
  log('video-stream', { frames: units.length })
}

function handleCommand(message) {
  switch (message.serviceType) {
    case carlife.CMD.HU_PROTOCOL_VERSION:
      if (versionMatched) return
      versionMatched = true
      log('hu-version', { payload: message.payload.toString('hex') })
      send(carlife.CHANNEL_CMD, carlife.CMD.PROTOCOL_VERSION_MATCH_STATUS, messages.encode('CarlifeProtocolVersionMatchStatus', { matchStatus: 1 }))
      setTimeout(() => send(carlife.CHANNEL_CMD, carlife.CMD.MD_INFO, messages.deviceInfo({ width: 640, height: 360 })), 80)
      setTimeout(() => send(carlife.CHANNEL_CMD, carlife.CMD.MD_MODULE_STATUS, messages.encode('CarlifeModuleStatusList', {
        cnt: 7,
        moduleStatus: [1, 2, 3, 4, 6, 8, 9].map(moduleID => ({ moduleID, statusID: 0 })),
      })), 160)
      return
    case carlife.CMD.HU_INFO:
      return
    case carlife.CMD.HU_FEATURE_CONFIG_RESPONSE:
      send(carlife.CHANNEL_CMD, carlife.CMD.MD_FEATURE_CONFIG_DONE, Buffer.alloc(0))
      return
    case carlife.CMD.HU_VIDEO_ENCODER_INIT:
      if (videoNegotiated) return
      videoNegotiated = true
      send(carlife.CHANNEL_CMD, carlife.CMD.VIDEO_ENCODER_INIT, messages.videoEncoderInfo(640, 360, 30))
      streamVideo()
      return
    case carlife.CMD.HU_HEARTBEAT:
      return
    default:
      return
  }
}

function attach(channel, socket) {
  sockets.set(channel, socket)
  const parser = new carlife.ChannelParser(channel)
  parsers.set(channel, parser)
  socket.on('data', chunk => {
    for (const message of parser.push(chunk)) {
      if (channel === carlife.CHANNEL_CMD) handleCommand(message)
      if (channel === carlife.CHANNEL_TOUCH) log('touch', { bytes: message.payload.length })
    }
  })
  socket.on('close', () => sockets.delete(channel))
  log('channel-open', { channel })
}

for (const [channel, port] of Object.entries(carlife.PORTS)) {
  net.createServer({ allowHalfOpen: true }, socket => attach(Number(channel), socket)).listen(port, '0.0.0.0')
}
log('listening', { channels: Object.keys(carlife.PORTS).length })

process.on('SIGTERM', () => { if (videoTimer) clearInterval(videoTimer); process.exit(0) })
