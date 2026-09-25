/**
 * Publish-shaped install into the DSH profile dependency closure
 * (`$DSH_HOME/profiles/node_modules`), which every profile resolves through.
 *
 * The package is copied as a real directory on purpose: a symlink would move
 * the plugin's realpath outside the closure and break its `@deepseek-ai/*`
 * imports.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
const closure = path.join(dshHome, 'profiles', 'node_modules')
const target = path.join(closure, pkg.name)

await mkdir(closure, { recursive: true })
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const item of ['lib', 'README.md', 'package.json']) {
  await cp(path.join(root, item), path.join(target, item), { recursive: true })
}

const scripts = ['render.py', 'convert_glb.py']
for (const script of scripts) await stat(path.join(target, 'lib', 'scripts', script))

console.log(`deployed ${pkg.name}@${pkg.version} to ${target}`)
console.log('add the row to a profile patch file, e.g. $DSH_HOME/profiles/web/cordis.patch.yml:')
console.log(`  - insert:\n      - id: blender\n        name: '${pkg.name}'`)
