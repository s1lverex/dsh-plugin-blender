/**
 * End-to-end smoke test: loads the host plugin with a stub Cordis context,
 * drives real headless Blender (convert + render), and serves the captured HTTP
 * routes on a real socket to check the listing and file routes.
 *
 * Requires a working `blender` on PATH. Run: npm run smoke
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import plugin from '../lib/index.js'
import { detectBlender } from '../lib/blender.js'

const run = promisify(execFile)
const found = detectBlender('')
if (found === undefined) {
  console.error('smoke: Blender is not installed; skipping')
  process.exit(0)
}
console.log(`smoke: using ${found.path} (${found.source})`)

const workDir = await mkdtemp(path.join(tmpdir(), 'dsh-blender-smoke-'))
const sourceDir = await mkdtemp(path.join(tmpdir(), 'dsh-blender-src-'))

const CUBE_OBJ = `# cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`
const objPath = path.join(sourceDir, 'cube.obj')
await writeFile(objPath, CUBE_OBJ)

const blendPath = path.join(sourceDir, 'scene.blend')
await run(found.path, [
  '-b',
  '--factory-startup',
  '-noaudio',
  '--python-expr',
  `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`
])

// ---------------------------------------------------------------- stub context
const tools = new Map()
const sections = []
const routes = []
const disposers = []

const attachments = {
  async saveImage({ data, mediaType }) {
    const width = data.readUInt32BE(16)
    const height = data.readUInt32BE(20)
    return { attachmentId: `stub-${data.length}`, mediaType, bytes: data.length, width, height }
  }
}

const carrier = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  }
}

const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    get: (name) => tools.get(name)
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    }
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  inject(_deps, callback) {
    return callback(ctx)
  },
  provide(name, service) {
    ctx[name] = service
  },
  get(name) {
    if (name === 'webServer') return carrier
    if (name === 'attachments') return attachments
    return undefined
  }
}

plugin.apply(ctx, {
  workDir,
  defaultWidth: 160,
  defaultHeight: 120,
  defaultSamples: 8,
  timeoutMs: 180000
})

assert.deepEqual(
  [...tools.keys()].sort(),
  ['blender_export_glb', 'blender_render', 'blender_status'],
  'the three tools must register'
)
const promptText = sections[0]?.text({ scope: undefined })
assert.ok(typeof promptText === 'string' && promptText.includes('blender_render'), 'the system prompt section must describe the tools')

// --------------------------------------------------------------------- status
const status = await tools.get('blender_status').execute({}, {})
assert.equal(status.available, true, 'status must report Blender as available')
assert.equal(status.models, 0)
console.log(`smoke: blender_status reports ${status.version}`)

// ------------------------------------------------------------------ convert
const converted = await tools.get('blender_export_glb').execute({ file: objPath, name: 'cube' }, {})
assert.equal(converted.meshes, 1, 'the cube must convert to one mesh')
assert.ok(converted.bytes > 0)
const glb = await readFile(converted.path)
assert.equal(glb.subarray(0, 4).toString('ascii'), 'glTF', 'the export must be a binary glTF container')
console.log(`smoke: exported cube.glb (${converted.bytes} bytes, ${converted.triangles} triangles)`)

// ------------------------------------------------------------------- render
const rendered = await tools.get('blender_render').execute({ file: objPath, samples: 8 }, {})
const png = await readFile(rendered.output)
assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'the render must be a PNG')
assert.equal(rendered.width, 160)
assert.equal(rendered.height, 120)
assert.ok(rendered.triangles >= 12, 'the render must report its geometry')
assert.equal(rendered.mediaType, 'image/png')
console.log(`smoke: rendered ${path.basename(rendered.output)} in ${rendered.seconds}s`)

// ------------------------------------------------------- render an existing .blend
const blendRender = await tools.get('blender_render').execute({ file: blendPath, camera: 'Camera', samples: 8 }, {})
assert.ok((await readFile(blendRender.output)).byteLength > 0, 'a .blend must render through its own camera')
console.log('smoke: rendered an existing .blend through its own camera')

// ---------------------------------------------------------------- HTTP routes
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname)
  const prefix = routes
    .filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const route = exact ?? prefix
  if (route === undefined) {
    res.writeHead(404).end()
    return
  }
  void route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

try {
  const listing = await (await fetch(`${origin}/blender/models`)).json()
  assert.equal(listing.models.length, 1, 'the listing must contain the exported model')
  assert.ok(listing.renders.length >= 2, 'the listing must contain both renders')
  assert.equal(listing.models[0].viewable, true, 'a .glb must be viewable in the browser')

  const modelResponse = await fetch(`${origin}${listing.models[0].url}`)
  assert.equal(modelResponse.status, 200)
  assert.equal(modelResponse.headers.get('content-type'), 'model/gltf-binary')
  assert.equal((await modelResponse.arrayBuffer()).byteLength, converted.bytes)

  const renderResponse = await fetch(`${origin}${listing.renders[0].url}`)
  assert.equal(renderResponse.headers.get('content-type'), 'image/png')

  const missing = await fetch(`${origin}/blender/file/deadbeefdeadbeef`)
  assert.equal(missing.status, 404, 'an unknown id must not serve a file')
  const traversal = await fetch(`${origin}/blender/file/..%2f..%2fetc%2fpasswd`)
  assert.equal(traversal.status, 404, 'a path cannot be named directly')
  console.log(`smoke: routes served ${listing.models.length} model(s) and ${listing.renders.length} render(s)`)
} finally {
  server.close()
  for (const dispose of disposers) dispose()
}

// ------------------------------------------------------------------- service
assert.ok(ctx.blender !== undefined, 'the plugin must provide the ctx.blender service')
assert.equal((await ctx.blender.listModels()).models.length, 1)

console.log('smoke: ok')
