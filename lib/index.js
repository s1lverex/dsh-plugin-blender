/**
 * dsh-plugin-blender — Blender for DeepSeek Harness.
 *
 * Host half: three model tools that drive headless Blender (render an image,
 * convert a model to .glb, report the connection), plus the HTTP routes that
 * feed the three.js viewer panel in the right sidebar.
 */
import { execFile } from 'node:child_process'
import { createReadStream, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModelRegistry, contentTypeFor, defaultWorkDir, detectBlender, runBlender } from './blender.js'
import { applyBlenderTools } from './tools.js'

export const name = 'blender'
export const inject = ['tools', 'systemPrompt']

const SCRIPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts')
const LIST_PATH = '/blender/models'
const FILE_PREFIX = '/blender/file/'
const ID_PATTERN = /^[0-9a-f]{16}$/
const SECTION_ORDER = 2160

/** Normalize a loader row's config into the shapes the runtime uses. */
export function resolveConfig(raw) {
  const input = raw ?? {}
  const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  const workDir = path.resolve(typeof input.workDir === 'string' && input.workDir.trim() ? input.workDir.trim() : defaultWorkDir())
  const modelDirs = Array.isArray(input.modelDirs)
    ? input.modelDirs.filter((dir) => typeof dir === 'string' && dir.trim()).map((dir) => path.resolve(dir.trim()))
    : []
  return {
    blenderPath: typeof input.blenderPath === 'string' ? input.blenderPath : '',
    workDir,
    modelDirs,
    timeoutMs: positive(input.timeoutMs, 300000),
    defaultWidth: positive(input.defaultWidth, 960),
    defaultHeight: positive(input.defaultHeight, 720),
    defaultSamples: positive(input.defaultSamples, 32),
    defaultEngine: typeof input.defaultEngine === 'string' ? input.defaultEngine : 'cycles',
    enableViewer: input.enableViewer !== false
  }
}

function publicEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    fileName: entry.fileName,
    kind: entry.kind,
    ext: entry.ext,
    viewable: entry.viewable,
    bytes: entry.bytes,
    mtime: entry.mtime,
    url: entry.url
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const registry = new ModelRegistry(config.workDir, config.modelDirs)
  mkdirSync(registry.modelsDir, { recursive: true })
  mkdirSync(registry.rendersDir, { recursive: true })

  let versionCache
  const runtime = {
    config,
    registry,
    blender: () => detectBlender(config.blenderPath),
    async version() {
      if (versionCache !== undefined) return versionCache
      const found = detectBlender(config.blenderPath)
      if (found === undefined || found.source === 'config-missing') return undefined
      versionCache = await new Promise((resolve) => {
        execFile(found.path, ['--version'], { timeout: 30000 }, (error, stdout) => {
          if (error) resolve(undefined)
          else resolve((stdout.split(/\r?\n/)[0] ?? '').trim() || undefined)
        })
      })
      return versionCache
    },
    async runScript(script, request, signal) {
      const found = detectBlender(config.blenderPath)
      if (found === undefined || found.source === 'config-missing') {
        throw new Error('Blender is not available, so nothing can be rendered or converted.')
      }
      return runBlender({
        binary: found.path,
        script: path.join(SCRIPT_DIR, script),
        request,
        timeoutMs: config.timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
        cwd: config.workDir
      })
    }
  }

  applyBlenderTools(ctx, runtime)

  ctx.systemPrompt.section({
    name: 'tool:blender',
    order: SECTION_ORDER,
    text: ({ scope }) =>
      ctx.tools.get('blender_render', scope) === undefined
        ? ''
        : [
            'Blender is connected through the blender_render, blender_export_glb and blender_status tools.',
            'Use blender_render to actually see a 3D model: it renders the file (a .blend, or any format Blender imports) and returns the image.',
            'Use blender_export_glb to publish a model as .glb into the 3D viewer panel in the workbench right sidebar, which the operator can orbit and inspect; a .blend or an unusual format must be exported before the panel can show it.',
            'Check blender_status first when a render fails, because it reports whether Blender was found, where, and at which version.'
          ].join(' ')
  })

  if (config.enableViewer) {
    ctx.inject(['webServer'], (viewerCtx) => {
      const carrier = viewerCtx.get('webServer')
      if (carrier === undefined) return
      viewerCtx.effect(() => {
        const disposeList = carrier.register({
          kind: 'exact',
          path: LIST_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const listing = registry.list()
            sendJson(res, 200, {
              workDir: config.workDir,
              models: listing.models.map(publicEntry),
              renders: listing.renders.map(publicEntry)
            })
          }
        })
        const disposeFile = carrier.register({
          kind: 'prefix',
          path: '/blender/file',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
            const id = pathname.startsWith(FILE_PREFIX) ? pathname.slice(FILE_PREFIX.length).replace(/\/+$/, '') : ''
            const entry = ID_PATTERN.test(id) ? registry.resolve(id) : undefined
            if (entry === undefined) {
              sendJson(res, 404, { error: 'unknown model id' })
              return
            }
            let size
            try {
              size = statSync(entry.path).size
            } catch {
              sendJson(res, 404, { error: 'model file is gone' })
              return
            }
            res.writeHead(200, {
              'content-type': contentTypeFor(entry),
              'content-length': size,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff'
            })
            if (req.method === 'HEAD') {
              res.end()
              return
            }
            const stream = createReadStream(entry.path)
            stream.on('error', () => res.destroy())
            stream.pipe(res)
          }
        })
        return () => {
          disposeList()
          disposeFile()
        }
      }, 'blender: viewer routes')
    })
  }

  ctx.provide('blender', {
    config,
    registry,
    detect: () => detectBlender(config.blenderPath),
    version: () => runtime.version(),
    listModels: () => registry.list(),
    render: (request, signal) => runtime.runScript('render.py', request, signal),
    convertToGlb: (request, signal) => runtime.runScript('convert_glb.py', request, signal)
  })
}

export default { name, inject, apply }
export { ModelRegistry, detectBlender, runBlender, defaultWorkDir }
