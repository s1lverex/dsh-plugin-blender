/**
 * Cheap structural checks: the host module loads and exports the plugin
 * contract, the client bundle is in the shell's module-table shape, and the
 * Blender scripts are present. `npm run smoke` covers the real behaviour.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const failures = []
const check = (label, condition) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures.push(label)
}

const host = await import(path.join(root, 'lib', 'index.js'))
check('host exports name', typeof host.name === 'string' && host.name.length > 0)
check('host exports apply', typeof host.apply === 'function')
check('host injects tools and systemPrompt', JSON.stringify(host.inject) === JSON.stringify(['tools', 'systemPrompt']))

const client = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')
check('client registers through the module loader', client.includes('window.__ModuleLoader__.load('))
check('client registers under the package name', client.includes(JSON.stringify(pkg.name)))
check('client exports apply and inject', /exports\.apply\s*=/.test(client) || client.includes('apply:'))
check('client is a single self-contained file', !/^\s*import\s/m.test(client))
check('package declares the web client', pkg.dsh?.client?.platform === 'web')
check('package exposes ./client', pkg.exports['./client'] !== undefined)

// The plugin market requires dsh.bundle + its patch file, not just dsh.client.
check('package declares a profile bundle', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
check('bundle patch inserts this package', patch.includes(pkg.name))
check('harness packages are peer dependencies', pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] !== undefined)
check('license file present', (await readFile(path.join(root, 'LICENSE'), 'utf8')).includes('MIT License'))
const declared = JSON.parse(await readFile(path.join(root, 'screenshots.json'), 'utf8'))
for (const shot of Array.isArray(declared) ? declared : (declared.screenshots ?? [])) {
  check(`screenshot ${shot} exists`, (await stat(path.join(root, shot))).isFile())
}

for (const script of ['render.py', 'convert_glb.py']) {
  const source = await readFile(path.join(root, 'lib', 'scripts', script), 'utf8')
  check(`${script} emits the result line`, source.includes('DSH_BLENDER_RESULT'))
}

if (failures.length > 0) {
  console.error(`\nverify: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nverify: ok')
