import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import tls from 'node:tls'
import {
  FLAG_BIT_FIRST,
  FLAG_ENCRYPTED,
  FLAG_HANDSHAKE,
  CONTROL_MSG,
  defaultFlags,
  encodeFrame,
  encodeTlsRecord,
  FrameParser,
} from './framing'

const VERSION_REQUEST = Buffer.from([0, 3, 0, 6, 0, 1, 0, 1, 0, 2])
const AUTH_COMPLETE_OK = Buffer.from([0, 3, 0, 4, 0, 4, 8, 0])

export interface AapMessage {
  channel: number
  type: number | null
  payload: Buffer
  flags: number
  declaredTotal?: number
}

export interface AaConnectionOptions {
  isServer: boolean
  secureContext?: tls.SecureContext
  log?: (event: string, data?: Record<string, unknown>) => void
}

// Speaks AAP over TCP: plaintext version exchange, then TLS with every TLS record carried
// inside an AAP frame. One TLS record per message is an invariant; sends are serialized so
// Node cannot coalesce two messages into one record.
export class AaConnection extends EventEmitter {
  private readonly socket: import('node:net').Socket
  private readonly isServer: boolean
  private readonly secureContext?: tls.SecureContext
  private readonly log: (event: string, data?: Record<string, unknown>) => void
  private secure = false
  private closed = false
  private versionConfirmed = false
  private readonly parser = new FrameParser()
  private tlsSocket?: tls.TLSSocket
  private wire?: Duplex
  private outQueue: Array<{ channel: number; flags: number; declaredTotal?: number }> = []
  private cipherTail: Buffer = Buffer.alloc(0)
  private currentRecord: { channel: number; flags: number; declaredTotal?: number } | null = null
  private sendChain: Promise<void> = Promise.resolve()

  constructor(socket: import('node:net').Socket, options: AaConnectionOptions) {
    super()
    this.socket = socket
    this.isServer = options.isServer
    this.secureContext = options.secureContext
    this.log = options.log ?? (() => {})
    socket.on('data', chunk => {
      let frames
      try {
        frames = this.parser.push(chunk)
      } catch (error) {
        this.log('framing-error', { message: (error as Error).message })
        socket.destroy()
        return
      }
      for (const frame of frames) {
        this.queue = this.queue.then(() => this.handleFrame(frame)).catch(error => {
          this.log('handle-error', { message: (error as Error).message })
        })
      }
    })
    socket.on('error', error => this.emit('transport-error', error))
    socket.on('close', () => {
      this.closed = true
      this.emit('close')
    })
  }

  private queue: Promise<void> = Promise.resolve()

  private writeFrame(frame: Buffer): void {
    if (process.env.AIRAUTO_AA_DEBUG === '1') this.log('frame-out', { flags: frame[1], bytes: frame.readUInt16BE(2) })
    this.socket.write(frame)
  }

  sendPlain(channel: number, type: number, payload: Buffer = Buffer.alloc(0)): void {
    this.writeFrame(encodeFrame({ channel, flags: FLAG_HANDSHAKE, type, payload }))
  }

  private sendTlsChunk(chunk: Buffer): void {
    if (!this.secure) {
      this.writeFrame(encodeFrame({ channel: 0, flags: FLAG_HANDSHAKE, type: CONTROL_MSG.ENCAPSULATED_SSL, payload: chunk }))
      return
    }
    this.cipherTail = this.cipherTail.length ? Buffer.concat([this.cipherTail, chunk]) : chunk
    while (this.cipherTail.length >= 5) {
      const recordLength = this.cipherTail.readUInt16BE(3)
      const total = 5 + recordLength
      if (this.cipherTail.length < total) break
      const record = this.cipherTail.subarray(0, total)
      this.cipherTail = this.cipherTail.subarray(total)
      const header = this.outQueue.shift() ?? { channel: 0, flags: 0x0b }
      this.writeFrame(encodeTlsRecord(header.channel, header.flags, record, header.declaredTotal))
    }
  }

  startVersionNegotiation(attempts = 3): void {
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

  startTls(): void {
    if (this.tlsSocket) return
    this.wire = new Duplex({
      read: () => {},
      write: (chunk, _encoding, callback) => {
        this.sendTlsChunk(chunk as Buffer)
        callback()
      },
    })
    this.tlsSocket = new tls.TLSSocket(this.wire, {
      isServer: this.isServer,
      secureContext: this.secureContext,
      requestCert: false,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    })
    this.tlsSocket.on('secure', () => {
      this.secure = true
      this.emit('secure')
    })
    this.tlsSocket.on('data', chunk => this.onPlaintext(chunk as Buffer))
    this.tlsSocket.on('error', error => {
      this.log('tls-error', { message: (error as Error).message })
      this.emit('transport-error', error)
      this.socket.destroy()
    })
    if (!this.isServer) (this.tlsSocket as unknown as { _start?: () => void })._start?.()
  }

  private onPlaintext(plaintext: Buffer): void {
    const record = this.currentRecord
    if (!record || !plaintext?.length) return
    if ((record.flags & FLAG_BIT_FIRST) !== 0) {
      if (plaintext.length < 2) return
      this.emit('message', {
        channel: record.channel,
        type: plaintext.readUInt16BE(0),
        payload: plaintext.subarray(2),
        flags: record.flags,
        declaredTotal: record.declaredTotal,
      } satisfies AapMessage)
      return
    }
    this.emit('message', {
      channel: record.channel,
      type: null,
      payload: plaintext,
      flags: record.flags,
      declaredTotal: record.declaredTotal,
    } satisfies AapMessage)
  }

  private async handleFrame(frame: import('./framing').AapFrame): Promise<void> {
    if (this.closed) return
    if (process.env.AIRAUTO_AA_DEBUG === '1') this.log('frame-in', { flags: frame.flags, type: frame.type, bytes: frame.payload.length })
    if (frame.flags === FLAG_HANDSHAKE) {
      if (frame.type === CONTROL_MSG.VERSION_REQUEST) {
        this.emit('version-request')
        return
      }
      if (frame.type === CONTROL_MSG.VERSION_RESPONSE) {
        this.versionConfirmed = true
        this.startTls()
        this.emit('version')
        return
      }
      if (frame.type === CONTROL_MSG.ENCAPSULATED_SSL) {
        this.wire?.push(frame.payload)
        return
      }
      this.emit('message', { channel: frame.channel, type: frame.type, payload: frame.payload, flags: frame.flags })
      return
    }
    if (frame.flags & FLAG_ENCRYPTED) {
      this.currentRecord = { channel: frame.channel, flags: frame.flags, declaredTotal: frame.declaredTotal }
      this.wire?.push(frame.payload)
      return
    }
  }

  sendAuthComplete(): void {
    this.socket.write(AUTH_COMPLETE_OK)
  }

  // type === null marks a middle/last fragment, which carries raw continuation bytes.
  send(channel: number, type: number | null, payload: Buffer = Buffer.alloc(0), flags?: number, declaredTotal?: number): void {
    if (!this.secure) throw new Error('send() before TLS is secure')
    let inner: Buffer
    if (type === null) {
      inner = payload
    } else {
      inner = Buffer.alloc(2 + payload.length)
      inner.writeUInt16BE(type >>> 0, 0)
      payload.copy(inner, 2)
    }
    const header = { channel, flags: flags ?? defaultFlags(channel, type ?? 0), declaredTotal }
    this.sendChain = this.sendChain.then(() => new Promise<void>(resolve => {
      if (this.closed) {
        resolve()
        return
      }
      this.outQueue.push(header)
      try {
        this.tlsSocket?.write(inner)
      } catch {}
      setTimeout(resolve, 1)
    }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.tlsSocket?.end()
    } catch {}
    this.socket.end()
  }
}

export { VERSION_REQUEST, AUTH_COMPLETE_OK }
