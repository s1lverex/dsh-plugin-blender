"""Headless Blender render step driven by dsh-plugin-blender.

Invoked as:  blender -b --factory-startup -noaudio -P render.py -- '<json>'

Accepts an existing .blend, or imports a model file (gltf/glb/obj/fbx/stl/ply/
dae/usd/abc), frames it with a generated camera, adds a key light when the scene
has none, renders one PNG and prints a single DSH_BLENDER_RESULT line of JSON.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector

RESULT_PREFIX = "DSH_BLENDER_RESULT "


def emit(payload: dict) -> None:
    print(RESULT_PREFIX + json.dumps(payload))


def fail(message: str) -> None:
    emit({"ok": False, "error": message})
    sys.exit(2)


IMPORT_OPS = {
    ".glb": ("import_scene", "gltf"),
    ".gltf": ("import_scene", "gltf"),
    ".obj": ("wm", "obj_import"),
    ".fbx": ("import_scene", "fbx"),
    ".stl": ("wm", "stl_import"),
    ".ply": ("wm", "ply_import"),
    ".dae": ("wm", "collada_import"),
    ".usd": ("wm", "usd_import"),
    ".usda": ("wm", "usd_import"),
    ".usdc": ("wm", "usd_import"),
    ".abc": ("wm", "alembic_import"),
}


def resolve_op(ext: str):
    entry = IMPORT_OPS.get(ext)
    if entry is None:
        return None
    group = getattr(bpy.ops, entry[0], None)
    if group is None:
        return None
    op = getattr(group, entry[1], None)
    return op if op is not None else None


def import_model(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return "blend"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    op = resolve_op(ext)
    if op is None:
        fail(f"unsupported input format for Blender: {ext or path}")
    op(filepath=path)
    return "import"


def world_bounds() -> tuple[Vector, Vector] | None:
    points: list[Vector] = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ Vector(corner))
    if not points:
        return None
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return low, high


def ensure_camera(center: Vector, radius: float) -> bpy.types.Object:
    scene = bpy.context.scene
    camera = scene.camera
    if camera is None:
        data = bpy.data.cameras.new("DSH_Camera")
        camera = bpy.data.objects.new("DSH_Camera", data)
        scene.collection.objects.link(camera)
        scene.camera = camera
    fov = camera.data.angle if camera.data.angle > 0 else math.radians(39.6)
    distance = radius / math.tan(fov / 2.0) * 1.25
    direction = Vector((1.0, -1.0, 0.62)).normalized()
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.clip_start = max(distance / 1000.0, 0.001)
    camera.data.clip_end = max(distance * 100.0, 100.0)
    return camera


def ensure_lighting(center: Vector, radius: float) -> None:
    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("DSH_World")
        scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs[0].default_value = (0.05, 0.055, 0.07, 1.0)
        background.inputs[1].default_value = 0.6
    if any(obj.type == "LIGHT" for obj in scene.objects):
        return
    data = bpy.data.lights.new("DSH_Key", type="AREA")
    data.energy = 120.0 * max(radius, 0.5) ** 2
    data.size = max(radius * 2.0, 1.0)
    light = bpy.data.objects.new("DSH_Key", data)
    scene.collection.objects.link(light)
    light.location = center + Vector((1.2, -1.4, 1.6)).normalized() * max(radius * 3.0, 2.0)
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    fill = bpy.data.lights.new("DSH_Fill", type="AREA")
    fill.energy = 30.0 * max(radius, 0.5) ** 2
    fill.size = max(radius * 3.0, 1.5)
    fill_obj = bpy.data.objects.new("DSH_Fill", fill)
    scene.collection.objects.link(fill_obj)
    fill_obj.location = center + Vector((-1.5, -0.6, 0.8)).normalized() * max(radius * 3.0, 2.0)
    fill_obj.rotation_euler = (center - fill_obj.location).to_track_quat("-Z", "Y").to_euler()


def apply_engine(scene: bpy.types.Scene, engine: str, samples: int) -> str:
    wanted = engine.upper()
    if wanted in {"EEVEE", "BLENDER_EEVEE"}:
        for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = candidate
                wanted = candidate
                break
            except TypeError:
                continue
    elif wanted in {"CYCLES", "WORKBENCH", "BLENDER_WORKBENCH"}:
        scene.render.engine = "BLENDER_WORKBENCH" if wanted == "WORKBENCH" else wanted
        wanted = scene.render.engine
    else:
        scene.render.engine = "CYCLES"
        wanted = "CYCLES"
    if wanted == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = samples >= 8
    elif wanted.startswith("BLENDER_EEVEE"):
        scene.eevee.taa_render_samples = samples
    return scene.render.engine


def main() -> None:
    if len(sys.argv) < 2:
        fail("missing render configuration argument")
    try:
        request = json.loads(sys.argv[-1])
    except json.JSONDecodeError as error:
        fail(f"invalid render configuration: {error}")

    source = request.get("input")
    output = request.get("output")
    if not source or not os.path.isfile(source):
        fail(f"input model not found: {source}")
    if not output:
        fail("missing output path")

    started = time.time()
    mode = import_model(source)
    scene = bpy.context.scene

    frame = request.get("frame")
    if isinstance(frame, int) and frame > 0:
        scene.frame_set(frame)

    bounds = world_bounds()
    if bounds is None:
        fail("the scene contains no mesh geometry to render")
    low, high = bounds
    center = (low + high) * 0.5
    radius = max((high - low).length * 0.5, 0.001)

    camera_name = request.get("camera")
    if camera_name:
        chosen = bpy.data.objects.get(camera_name)
        if chosen is None or chosen.type != "CAMERA":
            fail(f"camera not found in the file: {camera_name}")
        scene.camera = chosen
    elif mode == "blend" and scene.camera is not None:
        pass
    else:
        ensure_camera(center, radius)
    ensure_lighting(center, radius)

    width = int(request.get("width") or 960)
    height = int(request.get("height") or 720)
    samples = max(int(request.get("samples") or 32), 1)
    transparent = bool(request.get("transparent"))
    engine = apply_engine(scene, str(request.get("engine") or "cycles"), samples)

    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.render.filepath = output

    os.makedirs(os.path.dirname(output), exist_ok=True)
    bpy.ops.render.render(write_still=True)

    if not os.path.isfile(output):
        fail("Blender reported a render but wrote no file")

    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    triangles = 0
    for obj in meshes:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)

    emit(
        {
            "ok": True,
            "mode": mode,
            "engine": engine,
            "camera": scene.camera.name if scene.camera else None,
            "output": output,
            "width": width,
            "height": height,
            "samples": samples,
            "objects": len(scene.objects),
            "meshes": len(meshes),
            "triangles": triangles,
            "bounds": {
                "min": [round(value, 6) for value in low],
                "max": [round(value, 6) for value in high],
            },
            "seconds": round(time.time() - started, 3),
        }
    )


main()
