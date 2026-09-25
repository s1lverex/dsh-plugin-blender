# dsh-plugin-blender

Blender for DeepSeek Harness: the agent renders 3D models headlessly through
Blender, and the workbench gets a **3D Viewer** panel in the right sidebar that
loads the exported models with three.js and shows the rendered images.

Host half: three model tools plus two HTTP routes. Client half: one sidebar tab.
No runtime dependencies — the host uses node builtins, and the panel is one
prebuilt bundle.

---

## What it adds

**Three model tools.**

| Tool | Purpose |
| --- | --- |
| `blender_status` | The executable in use, its version, the work directory, and how many models/renders the panel lists. |
| `blender_render` | Render a 3D file to a PNG and return the image to the model. `.blend` files keep their own camera and lights; imported files are framed automatically. |
| `blender_export_glb` | Convert any supported file to `.glb` and publish it to the viewer panel. |

**One sidebar tab.** `blender-viewer-tab` in the right sidebar: a three.js
canvas with orbit/zoom controls, a model picker, and a strip of Blender's
renders (click one to view it full-panel).

**Two HTTP routes.** `GET /blender/models` lists what the panel may show;
`GET /blender/file/<id>` serves an already-scanned file. A request can only name
an id, never a path, so the routes cannot read outside the scanned directories.
They are registered on the web server directly, so they carry no session token:
with the default loopback bind only this machine can reach them, but a server
bound to `0.0.0.0` exposes the listed files to that network — set
`enableViewer: false` in that deployment.

**One Cordis service.** `ctx.blender` exposes `detect()`, `version()`,
`listModels()`, `render(request, signal)` and `convertToGlb(request, signal)`.

---

## Architecture

```
┌─ Host (Node) ──────────────────────────────────────────────┐
│  lib/index.js     Cordis plugin: name/inject/apply, routes │
│  lib/tools.js     the three defineTool definitions         │
│  lib/blender.js   detection, subprocess runner, registry   │
│  lib/scripts/render.py       bpy: import, frame, render    │
│  lib/scripts/convert_glb.py  bpy: import, export GLB       │
└──────────────────────────┬─────────────────────────────────┘
                           │  /blender/models, /blender/file/<id>
┌──────────────────────────┴─────────────────────────────────┐
│  src/client.jsx   tab type + slot registrations            │
│  lib/client.js    built bundle (three.js inside)           │
└─ Browser (web shell) ──────────────────────────────────────┘
```

Blender is driven as `blender -b --factory-startup -noaudio --python <step> --
<json>`; each step prints one `DSH_BLENDER_RESULT {json}` line, which the host
parses. Rendering defaults to Cycles on CPU, the reliable headless engine;
EEVEE and Workbench are available but need a GPU.

Cycles renders on CPU, so an unattended `blender_render` works on a headless
host. A 960x720x32-sample render of a simple model takes well under a second.

The panel loads `.glb`, `.gltf`, `.obj`, `.stl` and `.ply` directly. Everything
else (`.blend`, `.fbx`, `.dae`, `.usd`, `.abc`) must go through
`blender_export_glb` first, and the panel marks those entries.

---

## Requirements

- DeepSeek Harness `0.1.5` or a compatible `0.1.x` with the web profile
- Node.js 20 or newer
- Blender 3.6+ (4.x recommended) — headless works, no display needed

Blender is optional at load time: without it, the tools still register and fail
with an actionable message, and the panel still lists any `.glb` files that are
already in the models directory.

## Installation

The host resolves `@deepseek-ai/dsh-tools` from the profile dependency closure,
so the package must live there as a **real directory**; a symlink would move its
realpath out of the closure and break that import.

### From GitHub (one command, any machine)

`package.json` declares `dsh.bundle` with `cordis.patch.yml`, so the repository
installs as a profile bundle and the plugin row is composed automatically.
`lib/client.js` is committed prebuilt, so nothing is compiled on install.

```bash
dsh plugin --profile web add github:<owner>/dsh-plugin-blender
```

Then restart `dsh web` (a bundle install changes the tree, which the live patch
watcher does not cover). Blender must be installed on that machine; everything
else is in the package.

### From a local checkout

```bash
SRC=/path/to/dsh-plugin-blender
cd "$SRC" && npm install && npm run build     # produces lib/client.js
npm run deploy                                 # copies lib/ into $DSH_HOME/profiles/node_modules/dsh-plugin-blender
```

Then add one row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: blender
      name: 'dsh-plugin-blender'
```

The shipped web profile uses `patchReload: live`, so the row is picked up
without a restart. Editing a plugin's `lib/` afterwards is **not** watched —
re-run `npm run deploy` and restart `dsh web` after changing host code.

The tab opens itself once a session exists. It can also be opened by hand from
the right sidebar's **+** page ("3D Viewer").

### Publishing (maintainers)

```bash
GITHUB_TOKEN=... npm run publish:github    # creates the repo, sets the dsh-plugin topic, pushes
GITHUB_TOKEN=... npm run publish:market    # forks the registry and opens the entry PR
```

The token is a classic PAT with `repo` (or `public_repo`) and `read:user`. The
market lists one YAML entry per plugin (`data/plugins/<owner>__<repo>.yml`) and
requires the repo to declare `dsh.bundle` and to be **at least one day old**, so
run the market step the day after the first push.

### Blender detection

In order: the `blenderPath` config, `$BLENDER_PATH`, `blender` on `PATH`, then
common installs (`/usr/bin`, `/snap/bin`, `/opt`, `~/.local/share/blender*`,
`~/.local/bin`, macOS `Blender.app`, Windows `Program Files`). `blender_status`
reports which one won.

---

## Configuration reference

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `blenderPath` | string | `''` | Explicit Blender executable. Empty means auto-detect. |
| `workDir` | string | `$DSH_HOME/blender` | Holds `models/` and `renders/`. Created on load. |
| `modelDirs` | string[] | `[]` | Extra directories to list and serve in the panel (scanned 4 levels deep, 400 files max). |
| `timeoutMs` | number | `300000` | Per-render budget; the Blender process is killed when it expires. |
| `defaultWidth` | number | `960` | Default render width. |
| `defaultHeight` | number | `720` | Default render height. |
| `defaultSamples` | number | `32` | Default Cycles samples. |
| `defaultEngine` | string | `cycles` | `cycles`, `eevee` or `workbench`. |
| `enableViewer` | boolean | `true` | Register the viewer routes. |

Every key is optional; a row needs only `id` and `name`.

---

## Tools

### `blender_render`

| Argument | Meaning |
| --- | --- |
| `file` | Model or `.blend` to render. |
| `output` | Output path or file name; defaults to a timestamped PNG in `workDir/renders`. |
| `width`, `height`, `samples`, `engine` | Override the defaults for this render. |
| `frame` | Animation frame for an animated `.blend`. |
| `camera` | Camera name inside the `.blend` to render from. |
| `transparent` | Render with an alpha background. |

A `.blend` renders through its own camera when it has one; otherwise (and for
every imported format) the camera is placed to frame the geometry, and a key +
fill light pair is added only when the scene has no lights. The PNG is saved,
published as an attachment so a multimodal model actually receives it, and listed
in the panel.

### `blender_export_glb`

`file` plus an optional `name`; writes `workDir/models/<name>.glb`, strips
cameras and lights, exports Y-up, and returns the geometry statistics.

---

## Verification

```bash
npm run build     # lib/client.js
npm run verify    # structural checks on both halves
npm run client    # loads the bundle like the shell does, activates it, renders the panel
npm run smoke     # real headless Blender: convert, render, .blend render, HTTP routes
npm run viewer    # Chromium screenshot of the panel showing a Blender-exported model
```

`npm run smoke` writes a cube `.obj` and a `.blend` to a temp directory, converts
and renders both, asserts the GLB magic and PNG signature, then serves the
captured routes on a real socket and checks the listing, the content types, an
unknown id (404) and a path-traversal attempt (404). `npm run client` evaluates
`lib/client.js` through a stub module table, runs `apply()` against a stub shell
context and server-renders the registered tab. `npm run viewer` bundles the real
panel component for a standalone page, loads it in Chromium and screenshots the
three.js canvas (written to `test/viewer-shot.png`). The Blender-dependent
scripts exit 0 with a skip notice when Blender or Playwright is missing.

---

## Troubleshooting

**"Blender was not found"** — install Blender, put it on `PATH`, or set
`blenderPath` in the row config; `blender_status` echoes the path that was tried.

**The panel shows "no models yet"** — nothing has been exported. Ask the agent to
run `blender_export_glb`, or drop a `.glb` into `$DSH_HOME/blender/models`.

**The tab does not appear** — confirm `lib/client.js` exists and was built, that
the row's `name` matches the package name exactly, and that the deployed copy in
the closure is the one you edited (`npm run deploy`). Host `lib/` changes need a
`dsh web` restart.

**A model renders black or empty** — a Cycles render of a file with no geometry
fails with "the scene contains no mesh geometry to render". For imported files
the auto-camera is computed from mesh bounds, so a file with only cameras,
lights or empties cannot be framed.

**Renders are slow** — lower `samples` (8–16 is enough to judge a shape), lower
the resolution, or use `engine: workbench` when a GPU is present.

## License

MIT
