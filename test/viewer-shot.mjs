/**
 * Visual check of the panel: export and render a cube with real Blender,
 * bundle the actual viewer component for a standalone page, load that page in
 * Chromium and screenshot the three.js canvas.
 *
 * Skips (exit 0) when Blender or Playwright is unavailable.
 * Run: npm run viewer
 */
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import { detectBlender, runBlender } from '../lib/blender.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const blender = detectBlender('')
if (blender === undefined) {
  console.log('viewer: Blender is not installed; skipping')
  process.exit(0)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.log('viewer: Playwright is not installed; skipping')
  process.exit(0)
}

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-blender-viewer-'))
const objPath = path.join(scratch, 'cube.obj')
await writeFile(
  objPath,
  ['v -1 -1 -1', 'v 1 -1 -1', 'v 1 1 -1', 'v -1 1 -1', 'v -1 -1 1', 'v 1 -1 1', 'v 1 1 1', 'v -1 1 1',
   'f 1 2 3 4', 'f 5 8 7 6', 'f 1 5 6 2', 'f 2 6 7 3', 'f 3 7 8 4', 'f 4 8 5 1', ''].join('\n')
)

const glbPath = path.join(scratch, 'cube.glb')
const pngPath = path.join(scratch, 'cube.png')
await runBlender({
  binary: blender.path,
  script: path.join(root, 'lib', 'scripts', 'convert_glb.py'),
  request: { input: objPath, output: glbPath },
  timeoutMs: 180000
})
await runBlender({
  binary: blender.path,
  script: path.join(root, 'lib', 'scripts', 'render.py'),
  request: { input: objPath, output: pngPath, width: 320, height: 240, samples: 16, engine: 'cycles' },
  timeoutMs: 180000
})
const glb = await readFile(glbPath)
const png = await readFile(pngPath)

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { Viewer } from ${JSON.stringify(path.join(root, 'src', 'client.jsx'))}
      createRoot(document.getElementById('root')).render(React.createElement(Viewer))
    `,
    resolveDir: root,
    loader: 'jsx'
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' }
})

const listing = JSON.stringify({
  workDir: scratch,
  models: [{ id: 'aaaaaaaaaaaaaaaa', name: 'cube', fileName: 'cube.glb', kind: 'model', ext: 'glb', viewable: true, bytes: glb.byteLength, mtime: Date.now(), url: '/blender/file/aaaaaaaaaaaaaaaa' }],
  renders: [{ id: 'bbbbbbbbbbbbbbbb', name: 'cube', fileName: 'cube.png', kind: 'render', ext: 'png', viewable: false, bytes: png.byteLength, mtime: Date.now(), url: '/blender/file/bbbbbbbbbbbbbbbb' }]
})

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body style="margin:0;height:100vh"><div id="root" style="height:100vh"></div><script src="/bundle.js"></script></body></html>')
    return
  }
  if (pathname === '/bundle.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(bundle.outputFiles[0].text)
    return
  }
  if (pathname === '/blender/models') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(listing)
    return
  }
  if (pathname === '/blender/file/aaaaaaaaaaaaaaaa') {
    res.writeHead(200, { 'content-type': 'model/gltf-binary' })
    res.end(glb)
    return
  }
  if (pathname === '/blender/file/bbbbbbbbbbbbbbbb') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const shot = path.join(root, 'test', 'viewer-shot.png')
let browser
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('.dshbv-hint')?.textContent?.includes('.glb —'), undefined, { timeout: 30000 })
  const webgl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (canvas === null) return { canvas: false }
    return { canvas: true, width: canvas.width, height: canvas.height }
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot })
  const hint = await page.textContent('.dshbv-hint')
  assert.deepEqual(errors, [], 'the panel must not raise page errors')
  assert.equal(webgl.canvas, true, 'the stage must mount a canvas')
  assert.ok(webgl.width > 0 && webgl.height > 0, 'the canvas must be sized')
  assert.ok(hint.includes('cube.glb'), 'the model must load in the viewer')
  console.log(`viewer: ok — ${hint}`)
  console.log(`viewer: screenshot ${shot}`)
} finally {
  if (browser !== undefined) await browser.close()
  server.close()
}
