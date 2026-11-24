const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8')
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

// Minimal tree builder: a stray end tag closes the nearest matching open element,
// which is exactly how a browser recovers from unbalanced markup.
function parse(source) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null }
  const stack = [root]
  const tagPattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi
  let match
  while ((match = tagPattern.exec(source))) {
    if (match[1]) {
      const tag = match[1].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
      continue
    }
    if (!match[2]) continue
    const tag = match[2].toLowerCase()
    const attrs = {}
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
    let attr
    while ((attr = attrPattern.exec(match[3] || ''))) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? ''
    const node = { tag, attrs, children: [], parent: stack[stack.length - 1] }
    node.parent.children.push(node)
    if (!VOID.has(tag) && !match[4]) stack.push(node)
  }
  return root
}

function* walk(node) {
  for (const child of node.children) { yield child; yield* walk(child) }
}
const classes = node => (node.attrs.class || '').split(/\s+/).filter(Boolean)
const hasClass = (node, name) => classes(node).includes(name)
const ancestorWithClass = node => { for (let p = node.parent; p; p = p.parent) if (hasClass(p, 'page')) return p; return null }

test('every settings page stays inside the scroll container', () => {
  const root = parse(html)
  const container = [...walk(root)].find(node => hasClass(node, 'settings-content'))
  assert.ok(container, 'settings-content exists')
  assert.ok(container.children.length >= 9, 'all pages are direct children')
  for (const child of container.children) {
    assert.equal(child.tag, 'section', 'only page sections live under settings-content')
    assert.ok(hasClass(child, 'page'), 'child carries the page class')
  }
  assert.deepEqual(container.children.map(node => node.attrs.id), ['home', 'trip', 'appearance', 'connect', 'settings', 'connection', 'display', 'audio', 'about'])
})

test('no card or section title is orphaned outside a page', () => {
  const root = parse(html)
  const orphans = [...walk(root)].filter(node => (hasClass(node, 'card') || hasClass(node, 'section-title')) && !ancestorWithClass(node))
  assert.deepEqual(orphans.map(node => node.tag), [])
})

test('connection page keeps all of its sections and the CarLife fields inside a card', () => {
  const root = parse(html)
  const connection = [...walk(root)].find(node => node.attrs.id === 'connection')
  assert.ok(connection, 'connection page exists')
  const titles = [...walk(connection)].filter(node => hasClass(node, 'section-title'))
  assert.equal(titles.length, 4)
  const cards = [...walk(connection)].filter(node => hasClass(node, 'card'))
  assert.equal(cards.length, 4)
  const host = [...walk(connection)].find(node => node.attrs.id === 'carlifeHost')
  assert.ok(host, 'CarLife address input exists')
  let card = host.parent
  while (card && !hasClass(card, 'card')) card = card.parent
  assert.ok(card, 'CarLife address input must stay inside the device card')
})
