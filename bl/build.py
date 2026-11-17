"""Build a golf hole in Blender, render concept angles, and export it for the game.

    blender -b --factory-startup --python bl/build.py -- OUT --hole h7|h8 [--load] [--shots a,b|none]
                                   [--samples 96] [--res 1600x900] [--export GAME_ASSET_DIR] [--common]
Writes OUT/tex/*, OUT/golf_<hole>.blend, OUT/shots/<hole>_<name>.png.
--export writes <hole>.json, <hole>_h.bin and the surface masks; --common also writes the shared GLBs and
WebP terrain textures. --load reopens the saved .blend instead of rebuilding; --export-only skips the scene.
"""
import json
import math
import os
import shutil
import sys
import time
import traceback

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.expanduser("~"), ".claude", "skills", "procedural-pbr-assets", "scripts"))
import bkit as bk                        # noqa: E402
import noise as nz                       # noqa: E402
from pngio import write_png              # noqa: E402
import course                            # noqa: E402
import golf_tex                          # noqa: E402
import props                             # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0])
TEX = os.path.join(OUT, "tex")
SHOTS = os.path.join(OUT, "shots")


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


HOLE = course.HOLES[opt("--hole", "h7")]
BLEND = os.path.join(OUT, f"golf_{HOLE.key}.blend")
LOAD = "--load" in argv
ONLY = opt("--shots")
SAMPLES = int(opt("--samples", "96"))
RES = tuple(int(v) for v in opt("--res", "1600x900").split("x"))
EXPORT = opt("--export")
T0 = time.time()


def log(msg):
    print(f"[golf {time.time() - T0:6.1f}s] {msg}", flush=True)


def H(x, y):
    return float(HOLE.height(np.array([x]), np.array([y]))[0])


def mask_paths():
    return os.path.join(TEX, f"T_{HOLE.key}_A.png"), os.path.join(TEX, f"T_{HOLE.key}_B.png")


def write_masks():
    X, Y = HOLE.grid(HOLE.mask_step)
    F = HOLE.fields(X, Y)
    a, b = mask_paths()
    write_png(a, np.stack([F["fair"], F["green"], F["sand"]], -1))
    write_png(b, np.stack([F["path"], F["stripe"], F["macro"]], -1))


# ------------------------------------------------------------------ materials
def _mix(nt, a, b, fac, blend="MIX"):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type, m.blend_type = "RGBA", blend
    S = bk._sock
    for sock, v in ((S(m.inputs, "Factor_Float"), fac), (S(m.inputs, "A_Color"), a), (S(m.inputs, "B_Color"), b)):
        if hasattr(v, "is_linked") or hasattr(v, "node"):
            nt.links.new(v, sock)
        elif isinstance(v, (int, float)):
            sock.default_value = v
        else:
            sock.default_value = (*v, 1.0)
    return S(m.outputs, "Result_Color")


def terrain_material():
    mat = bk.tag(bpy.data.materials.new("M_Terrain"))
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    for key in ("Specular IOR Level", "Specular"):          # turf is matte: little sky sheen at grazing angles
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.2
            break
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    uvm = nt.nodes.new("ShaderNodeUVMap")
    uvm.uv_map = "UVMask"

    def img(fname, cs, scale=None, rot=0.0):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bk._image(fname, cs)
        if scale is None:
            nt.links.new(uvm.outputs[0], n.inputs[0])
        else:
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (scale, scale, 1)
            mp.inputs["Rotation"].default_value = (0, 0, rot)
            nt.links.new(uv.outputs[0], mp.inputs[0])
            nt.links.new(mp.outputs[0], n.inputs[0])
        return n

    def sep(node):
        s = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(node.outputs[0], s.inputs[0])
        return s

    A, B = sep(img(f"T_{HOLE.key}_A.png", "Non-Color")), sep(img(f"T_{HOLE.key}_B.png", "Non-Color"))
    layers = [("Rough", 3.0, None), ("Fairway", 2.0, A.outputs[0]), ("Green", 1.0, A.outputs[1]),
              ("Sand", 2.0, A.outputs[2]), ("Concrete", 4.0, B.outputs[0])]
    col = orm = nrm = None
    for name, tile, mask in layers:
        b = img(f"T_{name}_BaseColor.png", "sRGB", 1 / tile).outputs[0]
        o = img(f"T_{name}_ORM.png", "Non-Color", 1 / tile).outputs[0]
        n = img(f"T_{name}_Normal.png", "Non-Color", 1 / tile).outputs[0]
        if name == "Rough":                       # second, larger, rotated sample breaks up the tiling
            b = _mix(nt, b, img(f"T_{name}_BaseColor.png", "sRGB", 1 / 7.3, rot=0.9).outputs[0], 0.45)
        if name == "Fairway":
            b = _mix(nt, b, img(f"T_{name}_BaseColor.png", "sRGB", 1 / 5.1, rot=0.6).outputs[0], 0.4)
        if col is None:
            col, orm, nrm = b, o, n
        else:
            col, orm, nrm = _mix(nt, col, b, mask), _mix(nt, orm, o, mask), _mix(nt, nrm, n, mask)
    stripe = nt.nodes.new("ShaderNodeMapRange")              # mowing stripes: 0.5 = neutral
    stripe.inputs[3].default_value, stripe.inputs[4].default_value = 0.72, 1.28
    nt.links.new(B.outputs[1], stripe.inputs[0])
    tone = _mix(nt, (0.80, 0.78, 0.62), (1.10, 1.13, 1.08), B.outputs[2])
    col = _mix(nt, col, tone, 1.0, "MULTIPLY")
    sc = nt.nodes.new("ShaderNodeVectorMath")
    sc.operation = "SCALE"
    nt.links.new(col, sc.inputs[0])
    nt.links.new(stripe.outputs[0], sc.inputs["Scale"])
    nt.links.new(sc.outputs[0], bsdf.inputs["Base Color"])
    so = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(orm, so.inputs[0])
    nt.links.new(so.outputs[1], bsdf.inputs["Roughness"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "UVMap"
    nm.inputs["Strength"].default_value = 1.2
    nt.links.new(nrm, nm.inputs["Color"])
    nt.links.new(nm.outputs[0], bsdf.inputs["Normal"])
    return mat


def water_material():
    mat = bpy.data.materials.get("M_Water")
    if mat:
        return mat
    mat = bk.tag(bpy.data.materials.new("M_Water"))
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.012, 0.03, 0.022, 1)
    bsdf.inputs["Roughness"].default_value = 0.03
    bsdf.inputs["IOR"].default_value = 1.33
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.2, 3.0, 1.0)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 3.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    bump.inputs["Distance"].default_value = 0.05
    nt.links.new(tc.outputs["Object"], mp.inputs[0])
    nt.links.new(mp.outputs[0], noise.inputs[0])
    nt.links.new(noise.outputs[0], bump.inputs["Height"])
    nt.links.new(bump.outputs[0], bsdf.inputs["Normal"])
    return mat


def vcol_material(name, rough=0.85):
    mat = bk.tag(bpy.data.materials.new(name))
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    nt.links.new(vc.outputs[0], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    return mat


# ------------------------------------------------------------------ terrain, water, backdrop
def build_terrain(coll):
    step = HOLE.step
    X, Y = HOLE.grid()
    Z = HOLE.fields(X, Y)["h"]
    ny, nx = X.shape
    x0, x1, y0, y1 = HOLE.bounds
    V = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
    idx = np.arange(ny * nx).reshape(ny, nx)
    quads = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4)
    cx, cy = HOLE.cup                                          # cut the 108 mm hole into the cup's cell
    ci, cj = int((cx - x0) // step), int((cy - y0) // step)
    cell = quads[cj * (nx - 1) + ci].tolist()
    faces = np.delete(quads, cj * (nx - 1) + ci, 0).tolist()
    n0 = len(V)
    ang = np.radians(225) + np.arange(16) * math.tau / 16
    rx, ry = cx + 0.054 * np.cos(ang), cy + 0.054 * np.sin(ang)
    V = np.vstack([V, np.stack([rx, ry, HOLE.height(rx, ry)], 1)])
    c = [n0 + i for i in range(16)]
    for k in range(4):
        a, b = cell[k], cell[(k + 1) % 4]
        q = [c[(4 * k + m) % 16] for m in range(5)]
        faces += [[a, q[1], q[0]], [a, q[2], q[1]], [a, b, q[2]], [b, q[3], q[2]], [b, q[4], q[3]]]
    me = bk.tag(bpy.data.meshes.new("ENV_Terrain"))
    me.from_pydata(V.tolist(), [], faces)
    me.update()
    me.shade_smooth()
    co, lv = bk._loops(me)
    p = co[lv]
    me.uv_layers.new(name="UVMap").data.foreach_set("uv", p[:, :2].astype(np.float32).ravel())
    um = np.stack([(p[:, 0] - x0) / (x1 - x0), (p[:, 1] - y0) / (y1 - y0)], 1)
    me.uv_layers.new(name="UVMask").data.foreach_set("uv", um.astype(np.float32).ravel())
    me.materials.append(terrain_material())
    bk.ensure_vcol(me)
    return bk.new_obj("ENV_Terrain", me, coll)


def river_ribbon():
    """Left and right edge points of the water ribbon (wider than the channel, so it tucks under the banks)."""
    P = HOLE.river_pts
    t = np.gradient(P, axis=0)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    w = HOLE.river_w + 3.5
    return P + nrm * w, P - nrm * w


def build_water(coll):
    if HOLE.pond:
        pts = [(x, y, HOLE.water_z) for x, y in course.blob_outline(*HOLE.pond, wob=0.16, scale=1.15)]
        me = bk.tag(bpy.data.meshes.new("ENV_Pond"))
        me.from_pydata(pts, [], [list(range(len(pts)))])
        me.materials.append(water_material())
        bk.new_obj("ENV_Pond", me, coll)
    if HOLE.river:
        L, Rr = river_ribbon()
        n = len(L)
        V = [(x, y, HOLE.water_z) for x, y in L] + [(x, y, HOLE.water_z) for x, y in Rr]
        F = [[n + i, n + i + 1, i + 1, i] for i in range(n - 1)]
        me = bk.tag(bpy.data.meshes.new("ENV_River"))
        me.from_pydata(V, [], F)
        me.materials.append(water_material())
        bk.new_obj("ENV_River", me, coll)


def build_backdrop(coll):
    """Far hills so aerial shots have a horizon: 4 km of low-res wooded ridges, hazed with distance."""
    x0, x1, y0, y1 = HOLE.bounds
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    n = 96
    t = np.linspace(-2000, 2000, n)
    X, Y = np.meshgrid(t, t)
    r = np.maximum(np.abs(X) / (x1 - x0), np.abs(Y) / (y1 - y0)) * 2 * 180        # 180 = edge of the hole
    u, v = (X / 4000 + 0.5).astype(np.float32), (Y / 4000 + 0.5).astype(np.float32)
    f = nz.fbm(u, v, 5, 4, 91 + HOLE.seed)
    Z = -5.0 + nz.smoothstep(200, 1500, r) * (55 + 60 * f) + 6 * nz.fbm(u, v, 14, 3, 92) * nz.smoothstep(150, 400, r)
    V = np.stack([X.ravel() + cx, Y.ravel() + cy, Z.ravel()], 1)
    idx = np.arange(n * n).reshape(n, n)
    quads = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4)
    me = bk.tag(bpy.data.meshes.new("ENV_Backdrop"))
    me.from_pydata(V.tolist(), [], quads.tolist())
    me.shade_smooth()
    g = nz.fbm(u, v, 22, 3, 93).ravel()
    field = nz.smoothstep(0.1, 0.25, nz.fbm(u, v, 9, 2, 94).ravel())
    col = np.array([0.075, 0.13, 0.05])[None, :] * (1 + 0.35 * g[:, None])
    col = col * (1 - field[:, None]) + np.array([0.20, 0.28, 0.09])[None, :] * field[:, None] * (1 + 0.2 * g[:, None])
    haze = (nz.smoothstep(250, 1900, r).ravel() * 0.75)[:, None]
    col = col * (1 - haze) + np.array([0.36, 0.45, 0.55])[None, :] * haze
    _, lv = bk._loops(me)
    rgba = np.concatenate([np.clip(col, 0, 1), np.ones((len(col), 1))], 1)[lv]
    bk.ensure_vcol(me).data.foreach_set("color", rgba.astype(np.float32).ravel())
    me.materials.append(vcol_material("M_Backdrop", 0.9))
    return bk.new_obj("ENV_Backdrop", me, coll)


TREES = [dict(seed=11, H=14.0, trunk_r=0.30), dict(seed=12, H=17.0, trunk_r=0.36, tint=(0.94, 1.0, 0.96)),
         dict(seed=13, H=11.0, trunk_r=0.24, spread=(0.55, 1.05), tint=(1.06, 1.03, 0.9)),
         dict(seed=14, H=15.5, trunk_r=0.32, card=1.8, tint=(0.9, 0.97, 0.92))]


def tree_placements():
    """[(x, y, z, yaw, scale, z_scale, variant)], deterministic per hole."""
    rng = np.random.default_rng(2026 + HOLE.seed)
    x0, x1, y0, y1 = HOLE.bounds
    n = int(9000 * (x1 - x0) * (y1 - y0) / 50400)
    x = rng.uniform(x0 + 2, x1 - 2, n)
    y = rng.uniform(y0 + 2, y1 - 2, n)
    F = HOLE.fields(x, y)
    tx, ty = HOLE.tee
    clump = nz.smoothstep(0.2, 0.55, course._n(x, y, 50, 2, 77 + HOLE.seed))
    p = 0.015 + 0.95 * F["rim"] ** 0.5 + 0.22 * clump
    ok = ((F["rough"] > 0.95) & (F["d_f"] > 9) & (F["d_g"] > 13) & (F["d_t"] > 7) & (F["d_w"] > 6) & (F["d_c"] > 3.5)
          & (F["d_b"] > 6) & ~((np.abs(x - tx) < 18) & (y < ty + 35)) & (rng.random(n) < p))
    out = []
    cell = {}
    gap2 = HOLE.tree_gap
    g = math.sqrt(gap2)
    for i in np.flatnonzero(ok):
        key = (int(x[i] // g), int(y[i] // g))
        near = [q for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in cell.get((key[0] + dx, key[1] + dy), ())]
        if all((x[i] - a) ** 2 + (y[i] - b) ** 2 > gap2 for a, b in near):
            cell.setdefault(key, []).append((x[i], y[i]))
            s = rng.uniform(0.8, 1.3)
            out.append((float(x[i]), float(y[i]), float(F["h"][i] - 0.15), float(rng.uniform(0, math.tau)), float(s),
                        float(s * rng.uniform(0.9, 1.1)), int(rng.integers(0, len(TREES)))))
    return out


def placements():
    """Static dressing: [(kind, x, y, z, yaw_deg, extra)] in Blender coordinates."""
    tx, ty = HOLE.tee
    tz = HOLE.tee_z
    out = [("marker", tx - 3.2, ty + 2.0, tz, 0, {}), ("marker", tx + 3.2, ty + 2.0, tz, 0, {}),
           ("bench", tx - 4.1, ty - 2.5, tz, -90, {}), (f"sign_{HOLE.key}", tx - 4.2, ty + 4.8, tz, 20, {})]
    b = HOLE.bunkers[0]
    rx, ry = b[0] - 0.3, b[1] - 0.6
    out.append(("rake", rx, ry, H(rx, ry) + 0.01, -110, {}))
    cx, cy, cyaw = HOLE.cart
    out.append(("cart", cx, cy, H(cx, cy) + 0.005, cyaw + 90, {}))
    if HOLE.river:
        P = HOLE.river_pts
        t = np.gradient(P, axis=0)
        t /= np.linalg.norm(t, axis=1, keepdims=True)
        nrm = np.stack([-t[:, 1], t[:, 0]], 1)
        rng = np.random.default_rng(7 + HOLE.seed)
        for k, (frac, off) in enumerate([(0.14, 3.0), (0.25, -4.5), (0.36, 1.0), (0.47, 5.0), (0.55, -2.0), (0.66, 4.0),
                                         (0.74, -5.5), (0.80, 0.5)]):
            i = int(frac * (len(P) - 1))
            x, y = P[i] + nrm[i] * off
            yaw = math.degrees(math.atan2(t[i, 1], t[i, 0])) - 90 + rng.uniform(-35, 35)
            out.append(("log", float(x), float(y), HOLE.water_z - 0.05, yaw, {"seed": k % 4 + 1, "float": 1}))
        for frac, off in ((0.62, -2.5), (0.775, 1.5)):                       # one by the lay-up, one at the crossing
            i = int(frac * (len(P) - 1))
            x, y = P[i] + nrm[i] * off
            out.append(("gator", float(x), float(y), HOLE.water_z + 0.03,
                        math.degrees(math.atan2(t[i, 1], t[i, 0])) + 90 + rng.uniform(-25, 25), {"float": 1}))
    if getattr(HOLE, "bridge", None):
        (ax, ay), (bx, by) = HOLE.bridge
        z = max(H(ax, ay), H(bx, by)) + 0.06
        out.append(("bridge", ax, ay, z, math.degrees(math.atan2(by - ay, bx - ax)) - 90,
                    {"length": math.hypot(bx - ax, by - ay)}))
    return out


def make_prop(kind, name, coll, extra=None):
    extra = extra or {}
    if kind == "marker":
        return props.tee_marker(name, coll)
    if kind == "bench":
        return props.bench(name, coll)
    if kind.startswith("sign_"):
        h = course.HOLES[kind[5:]]
        yards = round(math.hypot(h.cup[0] - h.tee[0], h.cup[1] - h.tee[1]) * 1.0936)
        return props.tee_sign(name, coll, hole=str(h.number), par=f"PAR {h.par}", yards=f"{yards} YARDS")
    if kind == "rake":
        return props.rake(name, coll)
    if kind == "cart":
        return props.golf_cart(name, coll)
    if kind == "log":
        s = extra.get("seed", 1)
        return props.log(name, coll, L=2.6 + 0.35 * (s % 4), r=0.19 + 0.03 * (s % 3), seed=s)
    if kind == "gator":
        return props.gator(name, coll)
    if kind == "bridge":
        return props.bridge(name, coll, L=extra.get("length", 24.0))
    if kind == "flagstick":
        return props.flagstick(name, coll)
    if kind == "ball":
        return props.golf_ball(name, coll, subdiv=6)
    if kind == "peg":
        return props.tee_peg(name, coll)
    raise KeyError(kind)


# ------------------------------------------------------------------ scene
def build():
    bpy.ops.wm.read_homefile(use_empty=True)
    bk.purge()
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    golf_tex.run(TEX)
    write_masks()
    log("textures + masks")
    bk.set_texture_dir(TEX)
    props.register()
    env, kit = bk.collection("ENV"), bk.collection("KIT")
    build_terrain(env)
    build_water(env)
    build_backdrop(env)
    log("terrain")
    variants = [props.tree_mesh(f"ENV_Tree_Oak_{i + 1:02d}", **kw) for i, kw in enumerate(TREES)]
    tc = bk.collection("ENV/TREES")
    k = -1
    for k, (x, y, z, yaw, s, sz, v) in enumerate(tree_placements()):
        o = bk.new_obj(f"TREE_{k:04d}", variants[v], tc, loc=(x, y, z), rot=(0, 0, yaw))
        o.scale = (s, s, sz)
    log(f"{k + 1} trees")
    for k, (kind, x, y, z, yaw, extra) in enumerate(placements()):
        o = make_prop(kind, f"PROP_{kind}_{k}", kit, extra)
        o.location = (x, y, z)
        o.rotation_euler = (0, 0, math.radians(yaw))
    tx, ty = HOLE.tee
    cx, cy = HOLE.cup
    props.flagstick("PROP_Flagstick", kit, loc=(cx, cy, H(cx, cy)))
    bx, by = cx - 0.95, cy - 0.6
    props.golf_ball("PROP_Ball_Green", kit, loc=(bx, by, H(bx, by) + 0.0211))
    props.tee_peg("PROP_TeePeg", kit, loc=(tx + 0.4, ty + 0.8, HOLE.tee_z))
    props.golf_ball("PROP_Ball", kit, subdiv=7, loc=(tx + 0.4, ty + 0.8, HOLE.tee_z + 0.058))
    log("props")
    lit = bk.collection("LIGHT")
    bk.sun(lit, elev=40, azim=290, energy=4.6)
    sc.world = bk.sky_world(sun_elev=40, sun_azim=290, strength=0.2)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    log("saved " + BLEND)


def cam(name, loc, look, lens, fstop=None, focus=None):
    c = bk.camera(name, bk.collection("CAMS"), loc, look, lens=lens)
    if fstop:
        c.data.dof.use_dof = True
        c.data.dof.aperture_fstop = fstop
        c.data.dof.focus_distance = (Vector(focus or look) - Vector(loc)).length
    return c


def clear_spot(cands):
    """The candidate (x, y) farthest from any tree trunk, so a camera never sits inside a crown."""
    trees = [o.location for o in bpy.data.objects if o.name.startswith("TREE_")]
    return max(cands, key=lambda c: min((t.x - c[0]) ** 2 + (t.y - c[1]) ** 2 for t in trees))


def shots():
    tx, ty = HOLE.tee
    tz = HOLE.tee_z
    cx, cy = HOLE.cup
    cz = H(cx, cy)
    bx, by = cx - 0.95, cy - 0.6
    ball = (tx + 0.4, ty + 0.8, tz + 0.058)
    cart = Vector((HOLE.cart[0], HOLE.cart[1], H(HOLE.cart[0], HOLE.cart[1])))
    t = {
        "tee": lambda: cam("CAM_Tee", (tx + 0.9, ty - 6.6, tz + 1.7), (tx + 2.0, ty + 105, 0.6), 35),
        "green": lambda: cam("CAM_Green", (bx - 1.5, by - 2.1, H(bx - 1.5, by - 2.1) + 0.55), (cx - 0.2, cy, cz + 0.38), 35,
                             fstop=4.0, focus=(bx, by, cz)),
        "cart": lambda: cam("CAM_Cart", tuple(cart + Vector((-4.25, 2.73, 1.3))), tuple(cart + Vector((0, 0.0, 0.85))), 38),
        "ball": lambda: cam("CAM_Ball", (ball[0] + 0.20, ball[1] - 0.34, ball[2] + 0.035), ball, 70, fstop=5.6),
    }
    if HOLE.key == "h7":
        t.update({
            "aerial": lambda: cam("CAM_Aerial", (-62, -150, 58), (4, 22, 0), 27),
            "bunker": lambda: cam("CAM_Bunker", (-15.2, 45.0, H(-15.2, 45.0) + 1.0), (cx - 2, cy, cz + 0.9), 30),
            "approach": lambda: cam("CAM_Approach", (*clear_spot([(28, 19), (22, 26), (30, 32), (16, 34), (34, 40), (12, 28)]), 11),
                                    (cx - 2, cy - 3, cz), 40),
        })
    else:
        g = next(p for p in placements() if p[0] == "gator")
        gx, gy = g[1], g[2]
        t.update({
            "aerial": lambda: cam("CAM_Aerial", (-95, -110, 95), (5, 230, 0), 24),
            "river": lambda: cam("CAM_River", (gx - 9, gy - 13, HOLE.water_z + 1.5), (gx + 1, gy + 6, HOLE.water_z), 30),
            "gator": lambda: cam("CAM_Gator", (gx - 2.6, gy - 3.4, HOLE.water_z + 0.75), (gx, gy, HOLE.water_z + 0.05), 45),
            "cross": lambda: cam("CAM_Cross", (4, 352, H(4, 352) + 1.7), (cx, cy, cz + 1.0), 35),
            "bridge": lambda: cam("CAM_Bridge", (-41, 388, H(-41, 388) + 1.6), (-30, 408, HOLE.water_z + 0.9), 28),
        })
    return t


# ------------------------------------------------------------------ export for the game
def to_webp(src, dst, size=None, quality=86):
    """Re-save a PNG as WebP through a fresh image datablock (raw values, no colour management)."""
    src_img = bpy.data.images.load(src)
    w, h = src_img.size
    px = np.empty(w * h * 4, np.float32)
    src_img.pixels.foreach_get(px)
    img = bpy.data.images.new("_webp", w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(px)
    if size and w > size:
        img.scale(size, size)
    img.file_format = "WEBP"
    img.filepath_raw = dst
    try:
        img.save(quality=quality)
    except TypeError:
        img.save()
    bpy.data.images.remove(img)
    bpy.data.images.remove(src_img)


def export_hole(dst):
    os.makedirs(dst, exist_ok=True)
    X, Y = HOLE.grid()
    Z = HOLE.fields(X, Y)["h"].astype(np.float32)
    Z.tofile(os.path.join(dst, f"{HOLE.key}_h.bin"))
    a, b = mask_paths()
    if not os.path.exists(a):
        write_masks()
    shutil.copyfile(a, os.path.join(dst, f"{HOLE.key}_a.png"))
    shutil.copyfile(b, os.path.join(dst, f"{HOLE.key}_b.png"))

    def r3(v):
        return [round(float(q), 3) for q in v]
    data = dict(
        key=HOLE.key, number=HOLE.number, par=HOLE.par, name=HOLE.name, bounds=list(HOLE.bounds), step=HOLE.step,
        nx=int(X.shape[1]), ny=int(X.shape[0]), tee=list(HOLE.tee), teeZ=HOLE.tee_z, pins=[list(p) for p in HOLE.pins],
        waterZ=HOLE.water_z,
        pond=[r3(p) for p in course.blob_outline(*HOLE.pond, wob=0.16, scale=1.15)] if HOLE.pond else None,
        river=dict(pts=[r3(p) for p in HOLE.river_pts], halfWidth=HOLE.river_w + 3.5) if HOLE.river else None,
        trees=[r3(t[:6]) + [t[6]] for t in tree_placements()],
        props=[dict(kind=k, x=round(x, 3), y=round(y, 3), z=round(z, 3), yaw=round(yaw, 2), **extra)
               for k, x, y, z, yaw, extra in placements()],
    )
    json.dump(data, open(os.path.join(dst, f"{HOLE.key}.json"), "w"))
    log(f"exported {HOLE.key}: {len(data['trees'])} trees, {len(data['props'])} props")


def export_common(dst):
    os.makedirs(os.path.join(dst, "tex"), exist_ok=True)
    for name in ("Rough", "Fairway", "Green", "Sand", "Concrete"):
        to_webp(os.path.join(TEX, f"T_{name}_BaseColor.png"), os.path.join(dst, "tex", f"{name}_c.webp"))
        to_webp(os.path.join(TEX, f"T_{name}_Normal.png"), os.path.join(dst, "tex", f"{name}_n.webp"), quality=90)
    to_webp(os.path.join(TEX, "T_Water_Normal.png"), os.path.join(dst, "tex", "Water_n.webp"), quality=90)
    bpy.ops.wm.read_homefile(use_empty=True)
    bk.purge()
    bk.set_texture_dir(TEX)
    props.register()
    coll = bk.collection("EXPORT")
    lm = props.leaf_material()                                    # plain BSDF for glTF: drop the translucent mix
    nt = lm.node_tree
    nt.links.new(next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED").outputs[0],
                 next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL").inputs["Surface"])
    kinds = ["ball", "peg", "flagstick", "marker", "bench", "rake", "cart", "gator", "bridge"] + \
            [f"sign_{k}" for k in course.HOLES]
    sizes = {}
    for kind in kinds:
        o = make_prop(kind, "X_" + kind, coll, {"length": 24.0})
        objs = [o] + list(o.children_recursive)
        p = os.path.join(dst, f"{kind}.glb")
        bk.export_glb(objs, p)
        sizes[kind] = (sum(bk.tri_count(q.data) for q in objs if q.type == "MESH"), os.path.getsize(p))
        for q in objs:
            bpy.data.objects.remove(q)
    for s in range(1, 5):
        o = make_prop("log", f"X_log{s}", coll, {"seed": s})
        p = os.path.join(dst, f"log_{s}.glb")
        bk.export_glb([o], p)
        sizes[f"log_{s}"] = (bk.tri_count(o.data), os.path.getsize(p))
        bpy.data.objects.remove(o)
    for i, kw in enumerate(TREES):
        me = props.tree_mesh(f"Tree_{i + 1}", game=True, **kw)
        o = bk.new_obj(f"Tree_{i + 1}", me, coll, props={"height": me["height"], "trunk_r": kw["trunk_r"]})
        p = os.path.join(dst, f"tree_{i + 1}.glb")
        bk.export_glb([o], p)
        sizes[f"tree_{i + 1}"] = (bk.tri_count(me), os.path.getsize(p))
        bpy.data.objects.remove(o)
    for k, (t, b) in sizes.items():
        log(f"  {k:12s} {t:6d} tris  {b / 1024:7.0f} KB")


def main():
    if "--export-only" in argv:
        bk.set_texture_dir(TEX)
    elif LOAD:
        bpy.ops.wm.open_mainfile(filepath=BLEND)
        bk.set_texture_dir(TEX)
        for o in list(bpy.data.objects):
            if o.type == "CAMERA":
                bpy.data.objects.remove(o)
    else:
        build()
    if "--export-only" not in argv:
        sc = bpy.context.scene
        try:
            sc.cycles.transparent_max_bounces = 48
            sc.cycles.max_bounces = 8
        except Exception:
            pass
        os.makedirs(SHOTS, exist_ok=True)
        table = shots()
        for nme in (ONLY.split(",") if ONLY else list(table)):
            if nme == "none":
                continue
            bk.render(sc, table[nme](), os.path.join(SHOTS, f"{HOLE.key}_{nme}.png"), res=RES, samples=SAMPLES, world=sc.world)
            log("shot " + nme)
    if EXPORT:
        export_hole(EXPORT)
        if "--common" in argv:
            export_common(EXPORT)


try:
    main()
except Exception:
    print(traceback.format_exc(), flush=True)
    sys.exit(1)
