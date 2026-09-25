/**
 * Client-half check: evaluate lib/client.js the way the shell's module table
 * does (window.__ModuleLoader__.load + a factory receiving `require`), then run
 * the plugin's apply() against a stub shell context and server-render the
 * registered tab body. This catches a bundle that parses but cannot activate or
 * render, which no amount of grepping for `apply` would.
 *
 * Run: npm run client
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

const bundle = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')

let loaded
const window = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    }
  }
}

// The shell executes the bundle at the top level; so do we.
new Function('window', 'require', bundle)(window, (name) => require(name))

assert.ok(loaded !== undefined, 'the bundle must register through window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-plugin-blender', 'the registration id must equal the package name')
const client = loaded.factory((name) => require(name))
assert.equal(typeof client.apply, 'function', 'the factory must return apply')
assert.ok(Array.isArray(client.inject), 'the factory must return inject')

const tabs = []
const slots = []
const effects = []
const ctx = {
  get(name) {
    if (name === 'slots') return { inject: (_slot, register) => register(), register: (_key, component) => (slots.push(component), () => {}) }
    if (name === 'sidebarRightTabs') return { register: (definition) => (tabs.push(definition), () => {}) }
    if (name === 'sidebarRight') return { openTab: () => {} }
    return undefined
  },
  effect(fn, label) {
    effects.push(label)
    return fn()
  }
}

client.apply(ctx)
assert.equal(tabs.length, 1, 'one tab type must register')
assert.equal(tabs[0].kind, 'blender-viewer-tab')
assert.equal(tabs[0].title(), '3D Viewer')
assert.equal(slots.length, 2, 'the tab body and its title must both register')

const html = renderToStaticMarkup(React.createElement(slots[0]))
assert.ok(html.includes('dshbv-root'), 'the tab body must render its panel')
assert.ok(html.includes('Blender renders appear here.'), 'the empty renders strip must render')
const title = renderToStaticMarkup(React.createElement(slots[1]))
assert.ok(title.includes('3D Viewer'), 'the tab title must render')

console.log(`client: ok (${effects.length} effects, bundle ${(bundle.length / 1024).toFixed(0)} KiB)`)
