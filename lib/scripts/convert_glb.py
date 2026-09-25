"""Headless Blender glTF/GLB conversion step driven by dsh-plugin-blender.

Invoked as:  blender -b --factory-startup -noaudio -P convert_glb.py -- '<json>'

Opens a .blend or imports any supported model file and writes one .glb the
harness viewer can load in the browser, then prints a DSH_BLENDER_RESULT line.
"""
from __future__ import annotations

import json
import os
import sys
import time

import bpy
from mathutils import Vector

RESULT_PREFIX = "DSH_BLENDER_RESULT "

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


def emit(payload: dict) -> None:
    print(RESULT_PREFIX + json.dumps(payload))


def fail(message: str) -> None:
    emit({"ok": False, "error": message})
    sys.exit(2)


def resolve_op(ext: str):
    entry = IMPORT_OPS.get(ext)
    if entry is None:
        return None
    group = getattr(bpy.ops, entry[0], None)
    if group is None:
        return None
    return getattr(group, entry[1], None)


def main() -> None:
    if len(sys.argv) < 2:
        fail("missing conversion configuration argument")
    try:
        request = json.loads(sys.argv[-1])
    except json.JSONDecodeError as error:
        fail(f"invalid conversion configuration: {error}")

    source = request.get("input")
    output = request.get("output")
    if not source or not os.path.isfile(source):
        fail(f"input model not found: {source}")
    if not output:
        fail("missing output path")

    started = time.time()
    ext = os.path.splitext(source)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=source)
        mode = "blend"
    elif os.path.abspath(source) != os.path.abspath(output):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        op = resolve_op(ext)
        if op is None:
            fail(f"unsupported input format for Blender: {ext or source}")
        op(filepath=source)
        mode = "import"
    else:
        fail("input and output paths are the same file")

    scene = bpy.context.scene
    for obj in list(scene.objects):
        if obj.type == "CAMERA" or obj.type == "LIGHT":
            bpy.data.objects.remove(obj, do_unlink=True)

    os.makedirs(os.path.dirname(output), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output, export_format="GLB", export_yup=True)
    if not os.path.isfile(output):
        fail("Blender reported an export but wrote no file")

    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    triangles = 0
    for obj in meshes:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)

    points: list[Vector] = []
    for obj in meshes:
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ Vector(corner))
    bounds = None
    if points:
        low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
        high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
        bounds = {
            "min": [round(value, 6) for value in low],
            "max": [round(value, 6) for value in high],
        }

    emit(
        {
            "ok": True,
            "mode": mode,
            "output": output,
            "objects": len(scene.objects),
            "meshes": len(meshes),
            "triangles": triangles,
            "materials": len(bpy.data.materials),
            "bounds": bounds,
            "seconds": round(time.time() - started, 3),
        }
    )


main()
