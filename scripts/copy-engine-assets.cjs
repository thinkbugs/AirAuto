// tsc does not copy non-TS assets; the AA protocol needs its .proto files and the
// head-unit certificate next to the compiled output.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = path.join(root, 'src', 'engine', 'protocols', 'aa')
const target = path.join(root, 'build', 'engine', 'protocols', 'aa')

for (const dir of ['proto', 'cert']) {
  const from = path.join(source, dir)
  if (!fs.existsSync(from)) continue
  const to = path.join(target, dir)
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, name), path.join(to, name))
  }
}
console.log('engine assets copied')
