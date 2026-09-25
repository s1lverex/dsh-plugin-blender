/**
 * Client half of dsh-plugin-blender: a three.js panel in the right sidebar that
 * lists the models and Blender renders the host plugin has published.
 */
import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

export const TAB_ID = 'dsh-plugin-blender/viewer'
export const TAB_KIND = 'blender-viewer-tab'
export const inject = ['slots']

const LIST_PATH = '/blender/models'
const POLL_MS = 4000

const STYLE_ID = 'dsh-blender-viewer'
const STYLE_CSS = `
.dshbv-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary)}
.dshbv-hud{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-secondary);flex:none;min-width:0}
.dshbv-select{flex:1;min-width:0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-secondary);border-radius:4px;padding:2px 4px;font-size:12px}
.dshbv-btn{flex:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-secondary);border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer}
.dshbv-stage{position:relative;flex:1;min-height:0;background:#101216}
.dshbv-stage canvas{display:block;width:100%;height:100%}
.dshbv-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.92);padding:8px}
.dshbv-overlay img{max-width:100%;max-height:100%;object-fit:contain}
.dshbv-hint{position:absolute;left:8px;bottom:8px;color:rgba(226,232,240,.72);text-shadow:0 1px 2px rgba(0,0,0,.6);pointer-events:none}
.dshbv-strip{flex:none;display:flex;gap:6px;overflow-x:auto;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-secondary);min-height:56px}
.dshbv-thumb{flex:none;width:64px;height:44px;border-radius:4px;border:1px solid var(--dsw-alias-border-secondary);object-fit:cover;cursor:pointer;background:#000}
.dshbv-empty{color:var(--dsw-alias-label-tertiary);align-self:center;padding:0 4px}
.dshbv-log{padding:6px 10px;color:var(--dsw-alias-label-secondary);flex:none;border-top:1px solid var(--dsw-alias-border-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbv-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = STYLE_CSS
  document.head.appendChild(element)
}

function loaderFor(entry) {
  switch (entry.ext) {
    case 'glb':
    case 'gltf':
      return new GLTFLoader()
    case 'obj':
      return new OBJLoader()
    case 'stl':
      return new STLLoader()
    case 'ply':
      return new PLYLoader()
    default:
      return undefined
  }
}

function loadModel(entry, onObject, onError) {
  const loader = loaderFor(entry)
  if (loader === undefined) {
    onError(`the browser cannot read .${entry.ext}; export it as .glb with blender_export_glb first.`)
    return () => {}
  }
  let cancelled = false
  const url = entry.url
  if (loader instanceof GLTFLoader) {
    loader.load(url, (gltf) => !cancelled && onObject(gltf.scene), undefined, () => !cancelled && onError('the model could not be parsed.'))
    return () => {
      cancelled = true
    }
  }
  if (loader instanceof OBJLoader) {
    loader.load(url, (group) => !cancelled && onObject(group), undefined, () => !cancelled && onError('the model could not be parsed.'))
    return () => {
      cancelled = true
    }
  }
  const isPoints = loader instanceof PLYLoader
  loader.load(
    url,
    (geometry) => {
      if (cancelled) return
      if (isPoints) {
        geometry.computeVertexNormals()
        onObject(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb9c2d0, metalness: 0.1, roughness: 0.8 })))
        return
      }
      geometry.computeVertexNormals()
      onObject(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb9c2d0, metalness: 0.1, roughness: 0.8 })))
    },
    undefined,
    () => !cancelled && onError('the model could not be parsed.')
  )
  return () => {
    cancelled = true
  }
}

function disposeTree(object) {
  object.traverse((node) => {
    if (node.geometry !== undefined) node.geometry.dispose()
    const material = node.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else if (material !== undefined) material.dispose()
  })
}

function fitCamera(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(size.length() * 0.5, 0.001)
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.3
  const direction = new THREE.Vector3(1, 0.72, 1).normalize()
  camera.position.copy(center).addScaledVector(direction, distance)
  camera.near = Math.max(distance / 1000, 0.001)
  camera.far = distance * 100
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.update()
}

function Stage({ entry }) {
  const mountRef = useRef(null)
  const sceneRef = useRef(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    const mount = mountRef.current
    if (mount === null) return undefined
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x101216)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    camera.position.set(3, 2.4, 3)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f3a, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(4, 6, 4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-4, -2, -3)
    scene.add(fill)
    const grid = new THREE.GridHelper(10, 10, 0x2c313c, 0x1c2027)
    grid.position.y = -0.001
    scene.add(grid)

    const resize = () => {
      const width = Math.max(mount.clientWidth, 1)
      const height = Math.max(mount.clientHeight, 1)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    sceneRef.current = { scene, camera, controls, current: null }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      if (sceneRef.current?.current !== null) disposeTree(sceneRef.current.current)
      controls.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const runtime = sceneRef.current
    if (runtime === null) return
    if (runtime.current !== null) {
      runtime.scene.remove(runtime.current)
      disposeTree(runtime.current)
      runtime.current = null
    }
    if (entry === undefined) {
      setStatus('No model selected. Use blender_export_glb, or drop a .glb into the harness models directory.')
      return
    }
    setStatus(`Loading ${entry.fileName}…`)
    const cancel = loadModel(
      entry,
      (object) => {
        runtime.current = object
        runtime.scene.add(object)
        fitCamera(runtime.camera, runtime.controls, object)
        setStatus(`${entry.fileName} — ${(entry.bytes / 1024).toFixed(0)} KiB`)
      },
      (message) => setStatus(`${entry.fileName}: ${message}`)
    )
    return cancel
  }, [entry])

  return (
    <div className="dshbv-stage">
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="dshbv-hint">{status}</div>
    </div>
  )
}

export function Viewer() {
  const [index, setIndex] = useState({ models: [], renders: [] })
  const [selected, setSelected] = useState(undefined)
  const [render, setRender] = useState(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    ensureStyle()
    let live = true
    const poll = async () => {
      try {
        const response = await fetch(LIST_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (!live) return
        setIndex({ models: body.models ?? [], renders: body.renders ?? [] })
        setError('')
      } catch (failure) {
        if (live) setError(`viewer host unreachable (${String(failure.message ?? failure)})`)
      }
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (index.models.length === 0) {
      if (selected !== undefined) setSelected(undefined)
      return
    }
    if (selected === undefined || !index.models.some((model) => model.id === selected.id)) setSelected(index.models[0])
  }, [index, selected])

  return (
    <div className="dshbv-root">
      <div className="dshbv-hud">
        <select
          className="dshbv-select"
          value={selected?.id ?? ''}
          onChange={(event) => setSelected(index.models.find((model) => model.id === event.target.value))}
        >
          {index.models.length === 0 ? <option value="">no models yet</option> : null}
          {index.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.fileName}
              {model.viewable ? '' : ' (needs .glb export)'}
            </option>
          ))}
        </select>
        <button
          className="dshbv-btn"
          type="button"
          disabled={index.renders.length === 0}
          onClick={() => setRender(index.renders[0])}
        >
          Renders ({index.renders.length})
        </button>
      </div>
      <Stage entry={selected?.viewable ? selected : undefined} />
      {render !== undefined ? (
        <div className="dshbv-overlay" onClick={() => setRender(undefined)}>
          <img src={render.url} alt={render.fileName} />
        </div>
      ) : null}
      <div className="dshbv-strip">
        {index.renders.length === 0 ? <span className="dshbv-empty">Blender renders appear here.</span> : null}
        {index.renders.map((item) => (
          <img
            key={item.id}
            className="dshbv-thumb"
            src={item.url}
            alt={item.fileName}
            title={item.fileName}
            onClick={() => setRender(item)}
          />
        ))}
      </div>
      {error ? <div className="dshbv-log">{error}</div> : null}
    </div>
  )
}

function ViewerTitle() {
  return <span className="dshbv-title">3D Viewer</span>
}

function guideEntries() {
  return [
    {
      order: 60,
      title: () => '3D Viewer',
      description: () => 'Inspect models and Blender renders from the harness.'
    }
  ]
}

export function tabDefinition() {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => '3D Viewer',
    guide: guideEntries()
  }
}

function autoOpenTab(ctx) {
  let attempts = 0
  const MAX_ATTEMPTS = 60
  const RETRY_MS = 500
  const attempt = () => {
    attempts += 1
    const sidebarRight = ctx.get('sidebarRight')
    if (sidebarRight !== undefined) {
      try {
        sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
        return
      } catch {
        /* the shell is not ready yet; retry */
      }
    }
    if (attempts < MAX_ATTEMPTS) setTimeout(attempt, RETRY_MS)
  }
  setTimeout(attempt, 0)
}

export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const tabs = ctx.get('sidebarRightTabs')
  if (tabs !== undefined) {
    ctx.effect(() => tabs.register(tabDefinition()), 'blender: tab type')
    ctx.effect(
      () => slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Viewer)),
      'blender: tab body'
    )
    ctx.effect(
      () =>
        slots.inject('sidebar.right.pane.tab.title', () => slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ViewerTitle)),
      'blender: tab title'
    )
    autoOpenTab(ctx)
  }
}

export default { inject, apply }
