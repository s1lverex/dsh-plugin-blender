/**
 * Create the GitHub repository, tag it, and push this working tree.
 *
 *   GITHUB_TOKEN=... node scripts/publish-github.mjs [--owner <login>] [--repo <name>]
 *
 * The token needs classic `repo`/`public_repo` scope (repo creation, topics,
 * push) and `read:user` for the login lookup. No clone is required: the script
 * commits the current directory and pushes it.
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const token = process.env.GITHUB_TOKEN?.trim()
if (!token) {
  console.error('set GITHUB_TOKEN (classic PAT with repo + read:user)')
  process.exit(2)
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const api = async (method, route, body) => {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-blender-publish',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const text = await response.text()
  const parsed = text.length > 0 ? JSON.parse(text) : undefined
  return { status: response.status, ok: response.ok, body: parsed }
}

const me = await api('GET', '/user')
if (!me.ok) {
  console.error(`GitHub rejected the token (HTTP ${me.status}): ${me.body?.message ?? ''}`)
  process.exit(1)
}
const owner = flag('owner', me.body.login)
const repo = flag('repo', 'dsh-plugin-blender')
const full = `${owner}/${repo}`
console.log(`publishing ${full} as ${me.body.login}`)

// 1. package.json metadata must point back at the repository before the push.
const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: `git+https://github.com/${full}.git` }
pkg.homepage = `https://github.com/${full}#readme`
pkg.bugs = { url: `https://github.com/${full}/issues` }
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
await run('npm', ['run', 'build'], { cwd: root })
if (pkg.files !== undefined) await run('node', ['scripts/verify.mjs'], { cwd: root })

// 2. Create the repository (an existing one is fine) and set its metadata.
// A fine-grained token cannot create repositories, so an existing repo — which
// the operator created in the UI — is the normal path for those tokens.
const created = await api('POST', '/user/repos', {
  name: repo,
  description: pkg.description,
  homepage: pkg.homepage,
  private: false,
  has_issues: true,
  has_wiki: false,
  has_projects: false
})
if (created.ok) {
  console.log(`created ${full}`)
} else {
  const existing = await api('GET', `/repos/${full}`)
  if (!existing.ok) {
    console.error(`could not create the repository (HTTP ${created.status}): ${created.body?.message ?? ''}`)
    console.error(`create an empty public repository named ${repo} at https://github.com/new, then re-run this script.`)
    process.exit(3)
  }
  console.log(`${full} already exists; pushing into it (visibility: ${existing.body.visibility})`)
}

const topics = await api('PUT', `/repos/${full}/topics`, {
  names: ['dsh-plugin', 'dsh', 'deepseek-harness', 'cordis', 'blender', '3d', 'gltf']
})
console.log(
  topics.ok
    ? 'topics set (dsh-plugin, …)'
    : `topics rejected (HTTP ${topics.status}) — add the "dsh-plugin" topic by hand on the repository page; the market requires it`
)

// 3. Commit the tree and push it.
const git = (args) => run('git', args, { cwd: root })
const has = async (args) => {
  try {
    await git(args)
    return true
  } catch {
    return false
  }
}
if (!(await has(['rev-parse', '--git-dir']))) await git(['init', '-b', 'main'])
await git(['config', 'user.name', owner])
await git(['config', 'user.email', `${owner}@users.noreply.github.com`])
await git(['add', '-A'])
const status = await git(['status', '--porcelain'])
if (status.stdout.trim().length > 0) {
  await git(['commit', '-m', `dsh-plugin-blender ${pkg.version}`])
  console.log('committed the working tree')
} else {
  console.log('nothing new to commit')
}
await git(['remote', 'remove', 'origin']).catch(() => {})
await git(['remote', 'add', 'origin', `https://github.com/${full}.git`])
await git(['push', `https://x-access-token:${token}@github.com/${full}.git`, 'HEAD:refs/heads/main', '--force']).catch((error) => {
  console.error(`push failed: ${String(error.stderr ?? error.message).trim()}`)
  process.exit(1)
})

console.log(`\npublished: https://github.com/${full}`)
console.log('install on another machine:')
console.log(`  dsh plugin --profile web add github:${full}`)
