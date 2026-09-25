/**
 * Submit the plugin to the DSH plugin market (awesome-dsh-plugin.com).
 *
 *   GITHUB_TOKEN=... node scripts/open-market-pr.mjs [--owner <login>] [--repo <name>]
 *
 * One entry file `data/plugins/<owner>__<repo>.yml` is the whole submission.
 * The registry requires the repository to declare `dsh.bundle` and to be at
 * least one day old, so run this the day after the first push.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const token = process.env.GITHUB_TOKEN?.trim()
if (!token) {
  console.error('set GITHUB_TOKEN (classic PAT with repo scope; forks need a classic token)')
  process.exit(2)
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const api = async (method, route, body) => {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-blender-market',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const text = await response.text()
  return { status: response.status, ok: response.ok, body: text.length > 0 ? JSON.parse(text) : undefined }
}

const me = await api('GET', '/user')
if (!me.ok) {
  console.error(`GitHub rejected the token (HTTP ${me.status})`)
  process.exit(1)
}
const login = me.body.login
const repo = flag('repo', 'dsh-plugin-blender')
const owner = flag('owner', login)
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle === undefined) {
  console.error('package.json must declare dsh.bundle before submitting to the market')
  process.exit(1)
}

const entryFile = `data/plugins/${owner}__${repo}.yml`
const entry = [
  `url: https://github.com/${owner}/${repo}`,
  `name: ${owner}/${repo}`,
  'category: tools',
  'description:',
  "  en: 'Blender for DeepSeek Harness: renders 3D models headlessly and returns the image, converts any supported file to .glb, and shows both in a three.js viewer panel in the workbench sidebar.'",
  "  zh: '给 DeepSeek Harness 接上 Blender：无界面渲染 3D 模型并返回图像，把支持的模型转成 .glb，并在工作台侧栏的 three.js 面板里查看。'",
  ''
].join('\n')

// 1. Fork (idempotent) and wait for it to exist.
const fork = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`, { default_branch_only: true })
if (!fork.ok && fork.status !== 422) {
  console.error(`fork failed (HTTP ${fork.status}): ${fork.body?.message ?? ''}`)
  process.exit(1)
}
for (let attempt = 0; attempt < 30; attempt += 1) {
  const ready = await api('GET', `/repos/${login}/${UPSTREAM.repo}`)
  if (ready.ok) break
  await sleep(2000)
}

// 2. Branch off the fork's default branch.
const head = await api('GET', `/repos/${login}/${UPSTREAM.repo}/git/ref/heads/main`)
if (!head.ok) {
  console.error(`could not read the fork's main branch (HTTP ${head.status})`)
  process.exit(1)
}
const branch = `add-${repo}`
await api('POST', `/repos/${login}/${UPSTREAM.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.body.object.sha })

// 3. Add the single entry file on that branch.
const existing = await api('GET', `/repos/${login}/${UPSTREAM.repo}/contents/${entryFile}?ref=${branch}`)
const committed = await api('PUT', `/repos/${login}/${UPSTREAM.repo}/contents/${entryFile}`, {
  message: `Add ${owner}/${repo}`,
  content: Buffer.from(entry, 'utf8').toString('base64'),
  branch,
  ...(existing.ok ? { sha: existing.body.sha } : {})
})
if (!committed.ok) {
  console.error(`could not commit the entry (HTTP ${committed.status}): ${committed.body?.message ?? ''}`)
  process.exit(1)
}

// 4. Open the pull request.
const pull = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
  title: `Add ${repo}`,
  head: `${login}:${branch}`,
  base: 'main',
  body: [
    `Adds \`${entryFile}\` for [${owner}/${repo}](https://github.com/${owner}/${repo}).`,
    '',
    '- `package.json` declares `dsh.bundle` with `cordis.patch.yml`, so `dsh plugin --profile web add` installs it as a profile bundle.',
    '- Three tools: `blender_status`, `blender_render`, `blender_export_glb`. One sidebar tab: a three.js viewer for the exported models and Blender renders.',
    '- Verified with real headless Blender 4.5 (render + GLB round trip) and a Chromium screenshot of the panel.'
  ].join('\n')
})
if (!pull.ok) {
  console.error(`could not open the pull request (HTTP ${pull.status}): ${pull.body?.message ?? ''}`)
  process.exit(1)
}

console.log(`opened ${pull.body.html_url}`)
