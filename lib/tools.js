/**
 * The model-facing tools: render a 3D file to an image, and convert one into a
 * .glb the workbench viewer can display.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const text = (value) => ({ type: 'text', text: value })

// The attachment store normalises raster uploads (PNG without alpha becomes
// JPEG, PNG with alpha becomes WebP), so the canonical value must admit every
// media type the store can return rather than the one we wrote.
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function requireBlender(runtime) {
  const found = runtime.blender()
  if (found === undefined || found.source === 'config-missing') {
    const wanted = found?.path ?? runtime.config.blenderPath ?? 'blender'
    throw new Error(
      `Blender was not found (looked for ${wanted}). Install Blender, put \`blender\` on PATH, or set the plugin's blenderPath.`
    )
  }
  return found.path
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function safeName(value, fallback) {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  return cleaned.length > 0 ? cleaned : fallback
}

function sourceFile(input) {
  const resolved = path.resolve(input)
  return resolved
}

/** Register every tool and return their disposers. */
export function applyBlenderTools(ctx, runtime) {
  const disposers = []
  const config = runtime.config

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'blender_status',
        description:
          'Report the Blender connection: the executable in use, its version, the harness render directory, and how many models and renders the workbench viewer is currently listing.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean', required: true },
              blenderPath: { type: 'string' },
              blenderSource: { type: 'string' },
              version: { type: 'string' },
              workDir: { type: 'string', required: true },
              modelsDir: { type: 'string', required: true },
              rendersDir: { type: 'string', required: true },
              models: { type: 'integer', required: true },
              renders: { type: 'integer', required: true },
              viewerPath: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [
            text(
              value.available
                ? `Blender ${value.version ?? ''} at ${value.blenderPath} (found via ${value.blenderSource}). ${value.models} model(s) and ${value.renders} render(s) under ${value.workDir}; the workbench viewer reads ${value.viewerPath}.`
                : `Blender is not installed or not on PATH. Rendered output needs Blender; install it or set blenderPath. Work directory: ${value.workDir}.`
            )
          ]
        },
        async execute() {
          const found = runtime.blender()
          const listing = runtime.registry.list()
          return {
            available: found !== undefined && found.source !== 'config-missing',
            ...(found ? { blenderPath: found.path, blenderSource: found.source } : {}),
            ...(found ? { version: await runtime.version() } : {}),
            workDir: config.workDir,
            modelsDir: runtime.registry.modelsDir,
            rendersDir: runtime.registry.rendersDir,
            models: listing.models.length,
            renders: listing.renders.length,
            viewerPath: '/blender/models'
          }
        }
      })
    )
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'blender_render',
        description:
          'Render a 3D model with Blender and return the image, so you can see what the model looks like. Accepts .blend files and any format Blender imports (.glb, .gltf, .obj, .fbx, .stl, .ply, .dae, .usd, .abc). A .blend keeps its own camera and lights; an imported file is framed automatically. The PNG is also published to the 3D viewer panel in the right sidebar.',
        timeoutMs: config.timeoutMs + 15000,
        parameters: {
          file: { type: 'string', required: true, description: 'Path to the model or .blend file to render.' },
          output: { type: 'string', description: 'Optional output file name or path. Defaults to a timestamped PNG in the harness render directory.' },
          width: { type: 'integer', description: `Image width in pixels. Defaults to ${config.defaultWidth}.` },
          height: { type: 'integer', description: `Image height in pixels. Defaults to ${config.defaultHeight}.` },
          samples: { type: 'integer', description: `Render samples. Defaults to ${config.defaultSamples}; raise it for a cleaner Cycles image.` },
          engine: {
            type: 'string',
            enum: ['cycles', 'eevee', 'workbench'],
            description: 'Render engine. Defaults to cycles on CPU, which is the reliable headless choice.'
          },
          frame: { type: 'integer', description: 'Animation frame to render for a .blend with an animation.' },
          camera: { type: 'string', description: 'Name of a camera inside the .blend to render from.' },
          transparent: { type: 'boolean', description: 'Render with a transparent background instead of the studio backdrop.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              output: { type: 'string', required: true },
              url: { type: 'string', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              bytes: { type: 'integer', required: true },
              seconds: { type: 'number', required: true },
              engine: { type: 'string', required: true },
              meshes: { type: 'integer', required: true },
              triangles: { type: 'integer', required: true },
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: MEDIA_TYPES }
            }
          },
          render: (_args, value) => [
            text(
              `Rendered ${path.basename(value.output)} with Blender ${value.engine} (${value.width}x${value.height}, ${value.meshes} mesh(es), ${value.triangles} triangles, ${value.seconds}s). File: ${value.output}. It is also listed in the 3D viewer panel.`
            ),
            {
              type: 'image',
              attachment: {
                attachmentId: value.attachmentId,
                mediaType: value.mediaType,
                bytes: value.bytes,
                width: value.width,
                height: value.height
              }
            }
          ]
        },
        async execute(args, exec) {
          requireBlender(runtime)
          const input = sourceFile(args.file)
          const output =
            args.output !== undefined && args.output.trim().length > 0
              ? path.resolve(args.output)
              : path.join(runtime.registry.rendersDir, `${safeName(path.basename(input, path.extname(input)), 'model')}-${stamp()}.png`)
          const result = await runtime.runScript('render.py', {
            input,
            output,
            width: args.width ?? config.defaultWidth,
            height: args.height ?? config.defaultHeight,
            samples: args.samples ?? config.defaultSamples,
            engine: args.engine ?? config.defaultEngine,
            ...(args.frame !== undefined ? { frame: args.frame } : {}),
            ...(args.camera !== undefined ? { camera: args.camera } : {}),
            transparent: args.transparent === true
          }, exec.signal)

          const attachments = ctx.get('attachments')
          if (attachments === undefined) {
            throw new Error('this deployment has no attachment service, so a rendered image cannot be shown to the model.')
          }
          const data = await readFile(result.output)
          const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: path.basename(result.output) })
          runtime.registry.list()
          return {
            output: result.output,
            url: `/blender/file/${runtime.registry.idForPath(result.output) ?? ''}`,
            width: ref.width,
            height: ref.height,
            bytes: ref.bytes,
            seconds: result.seconds,
            engine: result.engine,
            meshes: result.meshes,
            triangles: result.triangles,
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType
          }
        }
      })
    )
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'blender_export_glb',
        description:
          'Convert a 3D file into .glb with Blender and publish it to the 3D viewer panel in the right sidebar, so the model can be inspected interactively in the workbench. Use this for .blend files or formats the browser cannot load directly (.fbx, .dae, .usd, .abc) and after you change a model.',
        timeoutMs: config.timeoutMs + 15000,
        parameters: {
          file: { type: 'string', required: true, description: 'Path to the model or .blend file to convert.' },
          name: { type: 'string', description: 'Optional output name; the panel lists it under this name. Defaults to the input file name.' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              path: { type: 'string', required: true },
              url: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              objects: { type: 'integer', required: true },
              meshes: { type: 'integer', required: true },
              triangles: { type: 'integer', required: true },
              materials: { type: 'integer', required: true },
              seconds: { type: 'number', required: true }
            }
          },
          render: (_args, value) => [
            text(
              `Exported ${value.name}.glb (${value.meshes} mesh(es), ${value.triangles} triangles, ${Math.round(value.bytes / 1024)} KiB) to ${value.path}. It is now listed in the 3D viewer panel, which loads it at ${value.url}.`
            )
          ]
        },
        async execute(args, exec) {
          requireBlender(runtime)
          const input = sourceFile(args.file)
          const base = safeName(args.name ?? path.basename(input, path.extname(input)), 'model')
          const output = path.join(runtime.registry.modelsDir, `${base}.glb`)
          const result = await runtime.runScript('convert_glb.py', { input, output }, exec.signal)
          const listing = runtime.registry.list()
          const entry = listing.models.find((model) => model.path === output)
          return {
            id: entry?.id ?? '',
            name: base,
            path: output,
            url: entry?.url ?? '',
            bytes: entry?.bytes ?? 0,
            objects: result.objects,
            meshes: result.meshes,
            triangles: result.triangles,
            materials: result.materials,
            seconds: result.seconds
          }
        }
      })
    )
  )

  return disposers
}
