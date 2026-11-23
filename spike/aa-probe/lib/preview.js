'use strict'

// Browser preview: serves a WebCodecs page and pushes the AA video channel to it. It only
// exists to eyeball the probe; WinPlay's real renderer is the Electron UI.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const PAGE = path.join(__dirname, '..', 'preview', 'preview.html')

function createPreview({ port, log = () => {} }) {
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(fs.readFileSync(PAGE))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const wss = new WebSocketServer({ noServer: true })
  let lastConfig = null
  let frames = 0

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, client => {
      log('preview-client', { total: wss.clients.size })
      if (lastConfig) client.send(JSON.stringify(lastConfig))
    })
  })

  function broadcast(payload) {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }

  return {
    broadcastConfig(configured) {
      lastConfig = {
        type: 'config',
        codec: configured.codec,
        description: configured.description.toString('base64'),
        width: configured.info.width,
        height: configured.info.height,
      }
      broadcast(JSON.stringify(lastConfig))
    },
    broadcastFrame(frame) {
      frames++
      const header = Buffer.alloc(9)
      header[0] = frame.keyframe ? 1 : 0
      header.writeBigUInt64BE(frame.timestamp ?? 0n, 1)
      const payload = Buffer.concat([header, frame.data])
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload, { binary: true })
      }
      if (frames <= 5 || frames % 300 === 0) log('preview-frame', { n: frames, keyframe: frame.keyframe, bytes: frame.bytes })
    },
    listen() {
      return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
          log('preview-listening', { url: `http://127.0.0.1:${port}/` })
          resolve()
        })
      })
    },
    close() {
      wss.close()
      server.close()
    },
  }
}

module.exports = { createPreview }
