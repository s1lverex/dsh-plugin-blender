/**
 * Bundle src/client.jsx into lib/client.js in the shell's module-table shape.
 *
 * The shell executes lib/client.js as a registration, not as a module: it must
 * call window.__ModuleLoader__.load with the package name as id and a factory
 * returning { apply, inject }. React and the harness packages stay external
 * because the shell's module table provides them.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

const externals = new Set(['react', 'react-dom', 'react-dom/client'])

const result = await build({
  entryPoints: [path.join(root, 'src', 'client.jsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: [...externals],
  plugins: [
    {
      name: 'dsh-externals',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({ path: args.path, external: true }))
      }
    }
  ]
})

if (result.outputFiles.length !== 1) throw new Error(`expected one bundle, got ${result.outputFiles.length}`)
const code = result.outputFiles[0].text.replace(/\/\/# sourceMappingURL=.*$/m, '')

const indent = (text) => text.split('\n').map((line) => (line.length > 0 ? `\t\t${line}` : line)).join('\n')

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indent(code)}
\t\tvar exported = module.exports;
\t\tif (exported.apply === void 0 && exported.default !== void 0) {
\t\t\texported.apply = exported.default.apply;
\t\t\texported.inject = exported.default.inject;
\t\t}
\t\tif (exported.apply === void 0 || exported.inject === void 0) {
\t\t\tthrow new Error(${JSON.stringify(pkg.name)} + ": client bundle must export apply and inject");
\t\t}
\t\treturn exported;
\t}
});
`

const target = path.join(root, 'lib', 'client.js')
await writeFile(target, wrapped)
console.log(`built ${path.relative(root, target)} (${(wrapped.length / 1024).toFixed(0)} KiB)`)
