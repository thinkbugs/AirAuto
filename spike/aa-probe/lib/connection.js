'use strict'

const { EventEmitter } = require('node:events')
const { Duplex } = require('node:stream')
const tls = require('node:tls')
const {
  FLAG_ENCRYPTED,
  FLAG_HANDSHAKE,
  CONTROL_MSG,
  defaultFlags,
  encodeFrame,
  FrameParser,
} = require('./framing')

const VERSION_REQUEST = Buffer.from([0, 3, 0, 6, 0, 1, 0, 1, 0, 2])
const AUTH_COMPLETE_OK = Buffer.from([0, 3, 0, 4, 0, 4, 8, 0])
const DECRYPT_TIMEOUT_MS = 500

// Speaks AAP over a TCP socket: plaintext version exchange first, then TLS where every
// TLS record travels inside an AAP frame (flags 3/type 3 while handshaking, then the
// frame's channel/flags carry the encrypted application record).
//
// Known spike limitation: one TLS record == one AAP frame is assumed, so post-handshake
// plaintext is attributed to the frame's channel and a record split across frames would
// be dropped with a `decrypt-error`. Video fragment assembly is out of scope here.
class AaConnection extends EventEmitter {
  constructor(socket, { isServer, secureContext, log = () => {} }) {
    super()
    this.socket = socket
    this.isServer = isServer
    this.secureContext = secureContext
    this.log = log
    this.secure = false
    this.closed = false
    this.versionConfirmed = false
    this.parser = new FrameParser()
    this.tlsSocket = null
    this.wire = null
    this.queue = Promise.resolve()
    this.outHeader = { channel: 0, flags: 0x0b }
    this.outQueue = []
    this.cipherTail = Buffer.alloc(0)
    this.inbound = []
    this.inboundPumping = false
    this.plaintextQueue = []
    this.pendingResolve = null
    this.sendChain = Promise.resolve()
    this.stats = { framesIn: 0, framesOut: 0, records: 0, messages: 0, videoFrames: 0, audioPackets: 0 }

    socket.on('data', chunk => {
      let frames
      try {
        frames = this.parser.push(chunk)
      } catch (error) {
        this.log('framing-error', { message: error.message })
        socket.destroy()
        return
      }
      for (const frame of frames) {
        this.stats.framesIn++
        if (process.env.AA_DEBUG) this.log('frame-in', { channel: frame.channel, flags: `0x${frame.flags.toString(16)}`, len: frame.length })
        this.queue = this.queue.then(() => this.#handleFrame(frame)).catch(error => {
          this.log('handle-error', { message: error.message })
        })
      }
    })
    socket.on('error', error => this.emit('transport-error', error))
    socket.on('close', () => {
      this.closed = true
      this.emit('close')
    })
  }

  #writeFrame(frame) {
    this.stats.framesOut++
    if (process.env.AA_DEBUG) this.log('frame-out', { channel: frame[0], flags: `0x${frame[1].toString(16)}`, len: frame.readUInt16BE(2) })
    this.socket.write(frame)
  }

  sendPlain(channel, type, payload = Buffer.alloc(0)) {
    this.#writeFrame(encodeFrame({ channel, flags: FLAG_HANDSHAKE, type, payload }))
  }

  // TLS may flush several records in one chunk and across write callbacks. AAP needs one
  // frame per record with the channel of the message that produced it, so split on TLS
  // record headers and pair each record with the oldest queued header.
  #sendTlsChunk(chunk) {
    if (!this.secure) {
      this.#writeFrame(encodeFrame({ channel: 0, flags: FLAG_HANDSHAKE, type: CONTROL_MSG.ENCAPSULATED_SSL, payload: chunk }))
      return
    }
    this.cipherTail = this.cipherTail.length ? Buffer.concat([this.cipherTail, chunk]) : chunk
    while (this.cipherTail.length >= 5) {
      const recordLength = this.cipherTail.readUInt16BE(3)
      const total = 5 + recordLength
      if (this.cipherTail.length < total) break
      const record = this.cipherTail.subarray(0, total)
      this.cipherTail = this.cipherTail.subarray(total)
      const header = this.outQueue.shift() || this.outHeader
      if (process.env.AA_DEBUG) this.log('tls-record-out', { channel: header.channel, bytes: total })
      this.#writeFrame(encodeTlsRecord(header.channel, header.flags, record))
    }
  }

  startVersionNegotiation(attempts = 3) {
    let attempt = 0
    const send = () => {
      if (this.closed || this.versionConfirmed) return
      attempt++
      this.log('version-request', { attempt })
      this.socket.write(VERSION_REQUEST)
      if (attempt < attempts) setTimeout(send, 2000)
    }
    send()
  }

  // Call once the version exchange is done; TLS continues over framed records.
  startTls() {
    if (this.tlsSocket) return
    this.wire = new Duplex({
      read() {},
      write: (chunk, _encoding, callback) => {
        this.#sendTlsChunk(chunk)
        callback()
      },
    })
    this.tlsSocket = new tls.TLSSocket(this.wire, {
      isServer: this.isServer,
      secureContext: this.secureContext,
      requestCert: false,
      rejectUnauthorized: false,
      // Android Auto negotiates TLS 1.2. Pinning it also avoids TLS 1.3 post-handshake
      // NewSessionTicket records, which produce no plaintext and break the one-record
      // one-channel pump used while this spike has no TLS record parser of its own.
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    })
    this.tlsSocket.on('secure', () => {
      this.secure = true
      this.log('tls-secure', { side: this.isServer ? 'head-unit' : 'phone-mock' })
      this.emit('secure')
    })
    // A persistent data listener keeps the TLS socket flowing. In paused/read() mode Node
    // only flushes pending writes while its read side is being serviced, which deadlocked
    // back-to-back sends until the peer happened to send another record.
    this.tlsSocket.on('data', chunk => this.#onTlsData(chunk))
    // A hand-built TLSSocket is in manualStart mode. Only the client may start the
    // handshake explicitly; a server-side TLSWrap rejects Start() and instead begins when
    // the ClientHello record arrives.
    if (!this.isServer) this.tlsSocket._start()
    this.tlsSocket.on('error', error => {
      this.log('tls-error', { message: error.message })
      this.emit('transport-error', error)
      this.socket.destroy()
    })
  }

  // Records are fed one at a time so each decrypted payload can be attributed to the
  // channel of the frame that carried it. Plaintext is pulled with read() rather than
  // collected from 'data' events: an event pump loses track of records that decrypt to
  // nothing (TLS session tickets), which then stalls or misattributes everything after it.
  // Encrypted frames are decrypted strictly in arrival order. The raw socket must stay
  // resumed: pausing it also stalls TLS's write path, which deadlocks the peer's replies.
  async #pumpInbound() {
    if (this.inboundPumping) return
    this.inboundPumping = true
    try {
      while (this.inbound.length && !this.closed) {
        const frame = this.inbound.shift()
        this.stats.records++
        let plaintext
        try {
          plaintext = await this.#feedRecord(frame.payload)
        } catch (error) {
          this.log('decrypt-error', { channel: frame.channel, message: error.message })
          this.emit('transport-error', error)
          continue
        }
        if (!plaintext) {
          this.log('decrypt-empty', { channel: frame.channel })
          continue
        }
        if (plaintext.length < 2) {
          this.log('empty-plaintext', { channel: frame.channel })
          continue
        }
        this.stats.messages++
        this.emit('message', {
          channel: frame.channel,
          type: plaintext.readUInt16BE(0),
          payload: plaintext.subarray(2),
          flags: frame.flags,
          declaredTotal: frame.declaredTotal,
        })
      }
    } finally {
      this.inboundPumping = false
    }
  }

  #onTlsData(chunk) {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      resolve(chunk)
      return
    }
    this.plaintextQueue.push(chunk)
  }

  #feedRecord(record) {
    if (this.plaintextQueue.length) return Promise.resolve(this.plaintextQueue.shift())
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingResolve = null
        resolve(null)
      }, DECRYPT_TIMEOUT_MS)
      this.pendingResolve = chunk => {
        clearTimeout(timer)
        this.pendingResolve = null
        resolve(chunk)
      }
      this.wire.push(record)
    })
  }

  async #handleFrame(frame) {
    if (this.closed) return
    if (frame.flags === FLAG_HANDSHAKE) {
      if (frame.type === CONTROL_MSG.VERSION_REQUEST) {
        this.log('version-request-received', {})
        this.emit('version-request')
        return
      }
      if (frame.type === CONTROL_MSG.VERSION_RESPONSE) {
        this.versionConfirmed = true
        this.log('version-response', { bytes: frame.payload.length })
        this.startTls()
        this.emit('version')
        return
      }
      if (frame.type === CONTROL_MSG.ENCAPSULATED_SSL) {
        if (!this.tlsSocket) {
          this.log('handshake-before-tls', { bytes: frame.payload.length })
          return
        }
        this.stats.records++
        this.wire.push(frame.payload)
        return
      }
      this.stats.messages++
      this.emit('message', { channel: frame.channel, type: frame.type, payload: frame.payload, flags: frame.flags })
      return
    }
    if (frame.flags & FLAG_ENCRYPTED) {
      this.inbound.push(frame)
      this.#pumpInbound()
      return
    }
    this.log('unexpected-frame', { channel: frame.channel, flags: frame.flags, bytes: frame.payload.length })
  }

  sendAuthComplete() {
    this.log('auth-complete', {})
    this.socket.write(AUTH_COMPLETE_OK)
  }

  // Encrypted application message; only valid after 'secure'.
  send(channel, type, payload = Buffer.alloc(0)) {
    if (!this.secure) throw new Error('send() before TLS is secure')
    const inner = Buffer.alloc(2 + payload.length)
    inner.writeUInt16BE(type >>> 0, 0)
    payload.copy(inner, 2)
    const header = { channel, flags: defaultFlags(channel, type) }
    this.outHeader = header
    // One TLS record per AA message is a protocol invariant (each record is decrypted as
    // one message). Node coalesces writes issued in the same turn into a single record, so
    // sends are serialized: the next write starts only after the previous record flushed.
    this.sendChain = this.sendChain.then(() => new Promise(resolve => {
      if (this.closed) {
        resolve()
        return
      }
      this.outQueue.push(header)
      if (process.env.AA_DEBUG) this.log('tls-write', { channel, type, inner: inner.length })
      this.tlsSocket.write(inner, () => setImmediate(resolve))
    }))
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.tlsSocket?.end()
    } catch {}
    this.socket.end()
  }
}

// Encrypted record frame: header carries channel/flags, body is the TLS record only.
function encodeTlsRecord(channel, flags, record) {
  const header = Buffer.alloc(4)
  header[0] = channel & 0xff
  header[1] = flags & 0xff
  header.writeUInt16BE(record.length, 2)
  return Buffer.concat([header, record])
}

module.exports = { AaConnection, VERSION_REQUEST, AUTH_COMPLETE_OK, encodeTlsRecord }
