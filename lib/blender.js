/**
 * Blender discovery, headless invocation, and the on-disk model registry the
 * viewer panel reads.
 *
 * Zero runtime dependencies: only node builtins.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Formats Blender can import for rendering or conversion. */
export const IMPORTABLE = ['.blend', '.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply', '.dae', '.usd', '.usda', '.usdc', '.abc']

/** Formats the browser panel can load directly, without Blender. */
export const VIEWABLE = new Set(['.glb', '.gltf', '.obj', '.stl', '.ply'])

export const RESULT_PREFIX = 'DSH_BLENDER_RESULT '

const MAX_SCAN_DEPTH = 4
const MAX_SCAN_FILES = 400
const MAX_SERVE_BYTES = 96 * 1024 * 1024

/** Default work directory: `$DSH_HOME/blender` (or `~/.dsh/blender`). */
export function defaultWorkDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'blender')
}

function isExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function blenderOnPath() {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const name of process.platform === 'win32' ? ['blender.exe', 'blender.cmd'] : ['blender']) {
      const candidate = path.join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function expanded(candidate) {
  if (!candidate) return undefined
  const trimmed = candidate.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('~')) return path.join(homedir(), trimmed.slice(1).replace(/^[/\\]/, ''))
  return trimmed
}

/** Common install locations across Linux, macOS and Windows. */
function commonCandidates() {
  const home = homedir()
  const list = [
    '/usr/bin/blender',
    '/usr/local/bin/blender',
    '/snap/bin/blender',
    '/opt/blender/blender',
    '/Applications/Blender.app/Contents/MacOS/Blender',
    'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe',
    path.join(home, '.local', 'bin', 'blender')
  ]
  for (const root of [path.join(home, '.local', 'share'), path.join(home, 'Applications'), path.join(home, 'blender'), '/opt']) {
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!/^blender/i.test(entry)) continue
      const dir = path.join(root, entry)
      for (const suffix of [
        path.join('blender'),
        path.join('Blender.app', 'Contents', 'MacOS', 'Blender'),
        path.join('Contents', 'MacOS', 'Blender')
      ]) {
        const candidate = path.join(dir, suffix)
        if (existsSync(candidate)) list.push(candidate)
      }
      try {
        if (statSync(dir).isDirectory()) {
          for (const inner of readdirSync(dir)) {
            if (/^blender/i.test(inner) && statSync(path.join(dir, inner)).isDirectory()) {
              list.push(path.join(dir, inner, 'blender'))
            }
          }
        }
      } catch {
        /* unreadable directory is not fatal */
      }
    }
  }
  return list
}

/**
 * Resolve the Blender executable.
 * Order: explicit config, `$BLENDER_PATH`, `blender` on PATH, common installs.
 * @returns {{ path: string, source: string } | undefined}
 */
export function detectBlender(configured) {
  const explicit = expanded(configured)
  if (explicit) {
    if (isExecutable(explicit)) return { path: explicit, source: 'config' }
    return { path: explicit, source: 'config-missing' }
  }
  const fromEnv = expanded(process.env.BLENDER_PATH)
  if (fromEnv && isExecutable(fromEnv)) return { path: fromEnv, source: 'BLENDER_PATH' }
  const onPath = blenderOnPath()
  if (onPath) return { path: onPath, source: 'PATH' }
  for (const candidate of commonCandidates()) {
    if (isExecutable(candidate)) return { path: candidate, source: 'common-install' }
  }
  return undefined
}

/** Latest `DSH_BLENDER_RESULT` JSON line, or undefined. */
export function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith(RESULT_PREFIX)) continue
    try {
      return JSON.parse(line.slice(RESULT_PREFIX.length))
    } catch {
      return { ok: false, error: 'Blender returned an unreadable result line' }
    }
  }
  return undefined
}

/**
 * Run one headless Blender Python step and return its parsed result.
 * @param {{ binary: string, script: string, request: object, timeoutMs: number, signal?: AbortSignal, cwd?: string }} options
 */
export function runBlender(options) {
  const args = ['-b', '--factory-startup', '-noaudio', '--python', options.script, '--', JSON.stringify(options.request)]
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(options.binary, args, {
      cwd: options.cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      finish(new Error(`Blender exceeded its ${Math.round(options.timeoutMs / 1000)}s budget and was stopped.`))
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const onAbort = () => {
      finish(new Error('Blender was cancelled.'))
      child.kill('SIGKILL')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024)
    })
    child.on('error', (error) => finish(new Error(`Blender could not be started (${options.binary}): ${error.message}`)))
    child.on('close', (code) => {
      const parsed = parseResult(stdout)
      if (parsed && parsed.ok === false) {
        finish(new Error(parsed.error ?? 'Blender reported a failure.'))
        return
      }
      if (!parsed) {
        const detail = stderr.trim().split(/\r?\n/).slice(-6).join('\n')
        finish(new Error(`Blender exited with code ${code} without a result.${detail ? `\n${detail}` : ''}`))
        return
      }
      finish(undefined, parsed)
    })
  })
}

function idFor(absolutePath) {
  return createHash('sha1').update(absolutePath).digest('hex').slice(0, 16)
}

function scanDirectory(root, kind, collector, depth = 0) {
  if (depth > MAX_SCAN_DEPTH || collector.length >= MAX_SCAN_FILES) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (collector.length >= MAX_SCAN_FILES) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      scanDirectory(full, kind, collector, depth + 1)
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (kind === 'render' ? ext !== '.png' : !IMPORTABLE.includes(ext)) continue
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    collector.push({
      id: idFor(full),
      name: path.basename(entry.name, ext),
      fileName: entry.name,
      path: full,
      ext: ext.replace('.', ''),
      kind,
      viewable: kind === 'render' ? false : VIEWABLE.has(ext),
      bytes: info.size,
      mtime: info.mtimeMs,
      url: `/blender/file/${idFor(full)}`
    })
  }
}

/**
 * Files the panel may list and the routes may serve. Only paths discovered by a
 * scan are servable, so a request can never name a path of its own.
 */
export class ModelRegistry {
  constructor(workDir, extraDirs = []) {
    this.workDir = workDir
    this.modelsDir = path.join(workDir, 'models')
    this.rendersDir = path.join(workDir, 'renders')
    this.extraDirs = extraDirs
    this.entries = new Map()
  }

  /** Re-scan every managed directory and return the current listing. */
  list() {
    this.entries = new Map()
    const models = []
    const renders = []
    scanDirectory(this.modelsDir, 'model', models)
    for (const dir of this.extraDirs) scanDirectory(dir, 'model', models)
    scanDirectory(this.rendersDir, 'render', renders)
    for (const entry of [...models, ...renders]) this.entries.set(entry.id, entry)
    const byAge = (a, b) => b.mtime - a.mtime
    return {
      workDir: this.workDir,
      models: models.sort(byAge),
      renders: renders.sort(byAge).slice(0, 24)
    }
  }

  /** Resolve a route id to a servable file, or undefined. */
  resolve(id) {
    if (this.entries.size === 0) this.list()
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    if (entry.bytes > MAX_SERVE_BYTES) return undefined
    return existsSync(entry.path) ? entry : undefined
  }

  /** Stable route id for one absolute path, whether or not it has been scanned yet. */
  idForPath(absolutePath) {
    return idFor(absolutePath)
  }
}

/** Content type for a served registry entry. */
export function contentTypeFor(entry) {
  switch (entry.ext) {
    case 'glb':
      return 'model/gltf-binary'
    case 'gltf':
      return 'model/gltf+json'
    case 'obj':
      return 'text/plain; charset=utf-8'
    case 'stl':
      return 'model/stl'
    case 'ply':
      return 'application/octet-stream'
    case 'png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}
