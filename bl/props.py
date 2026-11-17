"""Golf props and trees built with bkit at real sizes. Origin bottom-centre, front faces -Y."""
import math
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, __import__("os").path.join(__import__("os").path.expanduser("~"), ".claude", "skills", "procedural-pbr-assets", "scripts"))
import bkit as bk                        # noqa: E402

R = math.radians
T = Matrix.Translation


def RX(a):
    return Matrix.Rotation(R(a), 4, "X")


def RY(a):
    return Matrix.Rotation(R(a), 4, "Y")


def RZ(a):
    return Matrix.Rotation(R(a), 4, "Z")


YZ = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # local (a, b, c) -> world (c, a, b)


def register():
    reg = bk.register_material
    reg("fairway", "M_Fairway", "Fairway", None, 2.0)
    reg("green", "M_Green", "Green", None, 1.0)
    reg("rough", "M_Rough", "Rough", None, 3.0)
    reg("sand", "M_Sand", "Sand", None, 2.0)
    reg("bark", "M_Bark", "Bark", None, 1.0)
    reg("wood", "M_Wood", "Wood", None, 2.0)
    reg("leaves", "M_Leaves", "Leaves", None, 1.0, no_orm=True, rough=0.72)
    reg("ball", "M_Ball", base=(0.93, 0.93, 0.91), rough=0.2)
    reg("flag", "M_Flag", base=(0.72, 0.05, 0.04), rough=0.75)
    reg("vinyl", "M_Vinyl", base=(0.70, 0.64, 0.52), rough=0.5)
    reg("plastic_white", "M_Plastic_White", base=(0.86, 0.86, 0.84), rough=0.4)
    reg("soil", "M_Soil", base=(0.10, 0.075, 0.05), rough=0.95)
    reg("peg", "M_Peg", base=(0.80, 0.66, 0.42), rough=0.55)
    reg("chrome", "M_Chrome", base=(0.75, 0.75, 0.77), rough=0.18, metal=1.0)
    reg("cloth_blue", "M_Cloth_Blue", base=(0.05, 0.10, 0.22), rough=0.85)
    reg("headlamp", "M_Headlamp", base=(0.85, 0.85, 0.80), rough=0.08)
    reg("gator", "M_Gator", "Gator", None, 0.6)
    reg("gator_eye", "M_Gator_Eye", base=(0.85, 0.62, 0.06), rough=0.08)
    reg("tooth", "M_Tooth", base=(0.88, 0.85, 0.72), rough=0.3)


def leaf_material():
    """Alpha-tested, double-sided foliage card material (glTF alphaMode MASK)."""
    m = bk.material("leaves")
    if m.get("alpha_ready"):
        return m
    nt = m.node_tree
    tex = next(n for n in nt.nodes if n.type == "TEX_IMAGE")
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.4
    nt.links.new(tex.outputs["Alpha"], gt.inputs[0])
    nt.links.new(gt.outputs[0], bsdf.inputs["Alpha"])
    # Blender-only look: 35 % of the light passes through the leaf (relink the plain BSDF before export)
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    tr = nt.nodes.new("ShaderNodeBsdfTranslucent")
    nt.links.new(bsdf.inputs["Base Color"].links[0].from_socket, tr.inputs["Color"])
    m1 = nt.nodes.new("ShaderNodeMixShader")
    m1.inputs[0].default_value = 0.35
    nt.links.new(bsdf.outputs[0], m1.inputs[1])
    nt.links.new(tr.outputs[0], m1.inputs[2])
    tp = nt.nodes.new("ShaderNodeBsdfTransparent")
    m2 = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(gt.outputs[0], m2.inputs[0])
    nt.links.new(tp.outputs[0], m2.inputs[1])
    nt.links.new(m1.outputs[0], m2.inputs[2])
    nt.links.new(m2.outputs[0], out.inputs["Surface"])
    m.use_backface_culling = False
    for attr, val in (("blend_method", "CLIP"), ("alpha_threshold", 0.4)):
        try:
            setattr(m, attr, val)
        except Exception:
            pass
    m["alpha_ready"] = 1
    return m


def side_prism(mb, pts_yz, x0, x1, mat, smooth=False):
    """Extrude a side profile [(y, z)] (counter-clockwise seen from +X) across the width x0..x1."""
    bk.prism(mb, pts_yz, x0, x1, mat, M=YZ, smooth=smooth)


# ------------------------------------------------------------------ ball, tee, markers
def golf_ball(name, coll, subdiv=6, loc=(0, 0, 0)):
    """42.67 mm ball with 336 real dimples (3.6 mm across, 0.28 mm deep) on a Fibonacci lattice."""
    Rb = 0.021335
    dirs, faces = bk._icosphere_dirs(subdiv)
    n = 336
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    cen = np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)
    ang = np.arccos(np.clip((dirs @ cen.T).max(1), -1, 1))
    rd = 0.0018 / Rb
    prof = 0.00028 * np.clip(1 - (ang / rd) ** 2, 0, 1)
    P = dirs * (Rb - prof)[:, None]
    me = bk.tag(bpy.data.meshes.new(name))
    me.from_pydata(P.tolist(), [], faces)
    me.materials.append(bk.material("ball"))
    me.shade_smooth()
    bk.uv_box_project(me, 1.0)
    bk.ensure_vcol(me)
    me.update()
    return bk.new_obj(name, me, coll, loc=loc, props={"radius": Rb})


def tee_peg(name, coll, loc=(0, 0, 0)):
    """54 mm wooden tee, pushed 14 mm into the turf. Ball centre sits 61 mm above the origin."""
    mb = bk.MB()
    bk.lathe(mb, [(0.0004, -0.014), (0.0022, 0.0), (0.0024, 0.026), (0.0056, 0.038), (0.0058, 0.040),
                  (0.0034, 0.0385)], "peg", seg=12)
    return bk.obj_from_mb(mb, name, coll, loc=loc, sharp=None)


def tee_marker(name, coll, color="paint_blue", loc=(0, 0, 0)):
    """110 mm painted ball on a spike: the classic tee marker."""
    mb = bk.MB()
    prof = [(0.008, 0.0), (0.008, 0.012)]
    for k in range(13):
        a = -math.pi / 2 + math.pi * k / 12
        prof.append((max(0.055 * math.cos(a), 0.0005) if k not in (0,) else 0.008, 0.062 + 0.055 * math.sin(a)))
    bk.lathe(mb, prof, color, seg=20)
    o = bk.obj_from_mb(mb, name, coll, loc=loc, sharp=None)
    bk.grime_vcol(o.data, z0=0.0, height=0.12, strength=0.3)
    return o


# ------------------------------------------------------------------ flagstick and cup
def flagstick(name, coll, loc=(0, 0, 0)):
    """2.13 m pin in a 108 mm cup. The top 25 mm of the hole is bare soil, the liner sits below."""
    mb = bk.MB()
    bk.lathe(mb, [(0.054, 0.0), (0.054, -0.025)], "soil", seg=24, cap_bottom=False, cap_top=False)
    bk.lathe(mb, [(0.054, -0.025), (0.0525, -0.027), (0.0525, -0.125), (0.02, -0.132), (0.0005, -0.132)],
             "plastic_white", seg=24, cap_bottom=False, cap_top=False)
    bk.cyl(mb, (0, 0, -0.132), (0, 0, -0.05), 0.016, "chrome", seg=12, r1=0.010)       # ferrule
    z = -0.05
    for i, (h, mat) in enumerate([(0.35, "paint_white"), (0.30, "paint_red"), (0.30, "paint_white"),
                                  (0.30, "paint_red"), (0.93, "paint_yellow")]):
        bk.cyl(mb, (0, 0, z), (0, 0, z + h), 0.0065, mat, seg=10, caps=i == 4)
        z += h
    bk.lathe(mb, [(0.0065, z), (0.011, z + 0.006), (0.011, z + 0.016), (0.004, z + 0.026), (0.0005, z + 0.027)],
             "plastic_white", seg=12)
    o = bk.obj_from_mb(mb, name, coll, loc=loc, sharp=40.0)
    # flag: 510 x 360 mm cloth with a sleeve, rippling away from the pin (separate child so it can wave)
    fb = bk.MB()
    top = z - 0.02
    nx, nz_ = 14, 7
    rows = []
    for j in range(nz_ + 1):
        row = []
        for i in range(nx + 1):
            u = i / nx
            x = 0.008 + 0.51 * u
            y = 0.03 * math.sin(u * 9.0 + j * 0.35) * u + 0.012 * math.sin(u * 23.0) * u
            zz = top - 0.36 + 0.36 * j / nz_ - 0.05 * u * u
            row.append(fb.v((x, y, zz)))
        rows.append(row)
    for j in range(nz_):
        for i in range(nx):
            fb.face([rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]], "flag",
                    uv=[(i / nx, j / nz_), ((i + 1) / nx, j / nz_), ((i + 1) / nx, (j + 1) / nz_), (i / nx, (j + 1) / nz_)])
    bk.cyl(fb, (0, 0, top - 0.37), (0, 0, top + 0.005), 0.0085, "flag", seg=8, caps=False)
    f = bk.obj_from_mb(fb, name + "_Flag", coll, parent=o, sharp=None)
    for m in f.data.materials:
        m.use_backface_culling = False
    return o


# ------------------------------------------------------------------ rake, bench, sign
def rake(name, coll, loc=(0, 0, 0), yaw=0.0):
    """Bunker rake lying tines-down: 1.8 m handle, 600 mm head, 15 tines of 60 mm."""
    mb = bk.MB()
    bk.beam(mb, (-0.3, 0, 0.075), (0.3, 0, 0.075), 0.03, 0.025, "plastic_black")
    for i in range(15):
        x = -0.28 + 0.04 * i
        bk.cyl(mb, (x, 0, 0.065), (x, -0.004, 0.004), 0.0045, "plastic_black", seg=6, r1=0.002)
    bk.cyl(mb, (0, 0.0, 0.078), (0, 0.12, 0.076), 0.016, "plastic_black", seg=10)
    bk.cyl(mb, (0, 0.10, 0.076), (0, 1.80, 0.014), 0.012, "paint_yellow", seg=10)
    bk.cyl(mb, (0, 1.68, 0.018), (0, 1.81, 0.0135), 0.0145, "rubber_flat", seg=10)
    o = bk.obj_from_mb(mb, name, coll, loc=loc, bevel=(0.003, 1))
    o.rotation_euler = (0, 0, yaw)
    return o


def bench(name, coll, loc=(0, 0, 0), yaw=0.0):
    """1.5 m park bench: painted steel end frames, hardwood slats bolted on, seat at 0.45 m."""
    mb = bk.MB()
    for x in (-0.66, 0.66):
        bk.box(mb, (x, -0.20, 0.21), (0.05, 0.05, 0.42), "paint_green")
        bk.beam(mb, (x, 0.20, 0.0), (x, 0.31, 0.86), 0.05, 0.05, "paint_green", up=(0, 1, 0))
        bk.beam(mb, (x, -0.235, 0.42), (x, 0.26, 0.42), 0.05, 0.04, "paint_green")
        bk.beam(mb, (x, -0.26, 0.64), (x, 0.285, 0.64), 0.055, 0.03, "paint_green")
        bk.box(mb, (x, -0.22, 0.53), (0.04, 0.04, 0.20), "paint_green")
        for y in (-0.20, 0.20):
            bk.box(mb, (x, y + (0.0 if y < 0 else 0.004), 0.006), (0.09, 0.09, 0.012), "steel")
    bk.beam(mb, (-0.66, 0.0, 0.20), (0.66, 0.0, 0.20), 0.03, 0.03, "paint_green")
    for y in (-0.18, -0.065, 0.05, 0.165):
        bk.box(mb, (0, y, 0.454), (1.5, 0.095, 0.028), "wood")
        for x in (-0.66, 0.66):
            bk.cyl(mb, (x, y, 0.468), (x, y, 0.472), 0.008, "steel", seg=8)
    for z in (0.56, 0.68, 0.80):
        y = 0.20 + 0.11 * z / 0.86 - 0.04
        bk.box(mb, (0, 0, 0), (1.5, 0.028, 0.095), "wood", M=T((0, y, z)) @ RX(-7.3))
        for x in (-0.66, 0.66):
            bk.cyl(mb, (x, y - 0.014, z), (x, y - 0.019, z), 0.008, "steel", seg=8)
    o = bk.obj_from_mb(mb, name, coll, loc=loc, bevel=(0.004, 1))
    o.rotation_euler = (0, 0, yaw)
    bk.grime_vcol(o.data, z0=0.0, height=0.45, strength=0.3)
    return o


def text_obj(name, body, size, coll, mat="paint_white", parent=None, loc=(0, 0, 0)):
    cu = bpy.data.curves.new(name + "_c", "FONT")
    cu.body, cu.size, cu.extrude = body, size, 0.0015
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    tmp = bpy.data.objects.new(name + "_c", cu)
    bpy.context.scene.collection.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bk.tag(bpy.data.meshes.new_from_object(tmp.evaluated_get(dg)))
    bpy.data.objects.remove(tmp)
    bpy.data.curves.remove(cu)
    me.name = name
    me.materials.append(bk.material(mat))
    bk.ensure_vcol(me)
    o = bk.new_obj(name, me, coll, parent=parent, loc=loc)
    o.rotation_euler = (R(90), 0, 0)
    return o


def tee_sign(name, coll, hole="7", par="PAR 3", yards="172 YARDS", loc=(0, 0, 0), yaw=0.0):
    """Timber post with a routed, painted sign board."""
    mb = bk.MB()
    bk.box(mb, (0, 0, 0.55), (0.10, 0.10, 1.5), "wood", M=RY(0) @ T((0, 0, 0.0)))
    bk.prism(mb, [(-0.07, -0.07), (0.07, -0.07), (0.07, 0.07), (-0.07, 0.07)], 1.30, 1.33, "wood")
    bk.box(mb, (0, -0.066, 0.98), (0.50, 0.032, 0.40), "paint_green")
    bk.box(mb, (0, -0.084, 0.98), (0.46, 0.006, 0.36), "paint_green")
    for sx in (-1, 1):
        for sz in (-1, 1):
            bk.cyl(mb, (sx * 0.215, -0.087, 0.98 + sz * 0.165), (sx * 0.215, -0.092, 0.98 + sz * 0.165), 0.007, "steel", seg=8)
    o = bk.obj_from_mb(mb, name, coll, loc=loc, bevel=(0.005, 1))
    bk.grime_vcol(o.data, z0=0.0, height=0.5, strength=0.3)
    text_obj(name + "_No", hole, 0.19, coll, parent=o, loc=(0, -0.088, 1.035))
    text_obj(name + "_Par", par, 0.055, coll, parent=o, loc=(0, -0.088, 0.905))
    text_obj(name + "_Yds", yards, 0.038, coll, parent=o, loc=(0, -0.088, 0.845))
    o.rotation_euler = (0, 0, yaw)
    return o


# ------------------------------------------------------------------ golf cart
def _wheel(mb, pos):
    M = T(pos) @ RY(90)
    bk.lathe(mb, [(0.105, -0.085), (0.19, -0.098), (0.222, -0.08), (0.23, -0.05), (0.23, 0.05), (0.222, 0.08),
                  (0.19, 0.098), (0.105, 0.085)], "rubber_flat", seg=28, M=M, cap_bottom=False, cap_top=False)
    for k in range(-2, 3):                                                   # tread ribs
        bk.lathe(mb, [(0.23, k * 0.032 - 0.009), (0.2335, k * 0.032 - 0.006), (0.2335, k * 0.032 + 0.006),
                      (0.23, k * 0.032 + 0.009)], "rubber_flat", seg=28, M=M, cap_bottom=False, cap_top=False)
    s = 1 if pos[0] > 0 else -1
    bk.lathe(mb, [(0.0005, -0.07), (0.105, -0.07), (0.108, -0.05), (0.108, 0.05), (0.105, 0.07), (0.06, 0.055),
                  (0.035, 0.085), (0.0005, 0.09)] if s > 0 else
             [(0.0005, -0.09), (0.035, -0.085), (0.06, -0.055), (0.105, -0.07), (0.108, -0.05), (0.108, 0.05),
              (0.105, 0.07), (0.0005, 0.07)], "plastic_white", seg=20, M=M)
    bk.bolts_circle(mb, (pos[0] + s * 0.056, pos[1], pos[2]), (s, 0, 0), 0.05, 4, 0.008, 0.012, "chrome")


def _bag(mb):
    """Cart bag: 0.9 m tall, 230-270 mm across, cuffs, pockets, seven clubs."""
    bk.lathe(mb, [(0.115, 0.0), (0.12, 0.02), (0.12, 0.06)], "plastic_black", seg=16)
    bk.lathe(mb, [(0.118, 0.06), (0.125, 0.45), (0.135, 0.84)], "cloth_blue", seg=16, cap_bottom=False, cap_top=False)
    bk.lathe(mb, [(0.138, 0.84), (0.142, 0.87), (0.138, 0.90), (0.118, 0.90), (0.118, 0.84)], "plastic_black", seg=16,
             cap_bottom=False, cap_top=False)
    bk.box(mb, (0, 0.125, 0.30), (0.17, 0.07, 0.36), "cloth_blue")
    bk.box(mb, (0, 0.132, 0.62), (0.15, 0.05, 0.20), "cloth_blue")
    bk.box(mb, (0.12, 0.0, 0.40), (0.05, 0.13, 0.30), "cloth_blue")
    rng = np.random.default_rng(5)
    for i in range(7):
        a = i * 0.9
        x, y = 0.07 * math.cos(a), 0.07 * math.sin(a)
        top = 0.90 + rng.uniform(0.16, 0.30)
        tx, ty = x * 1.35, y * 1.35
        bk.cyl(mb, (x, y, 0.80), (tx, ty, top), 0.0045, "chrome", seg=6)
        if i < 2:                                                             # woods under knit covers
            bk.lathe(mb, [(0.0005, -0.01), (0.03, 0.0), (0.045, 0.035), (0.042, 0.07), (0.02, 0.092), (0.0005, 0.095)],
                     "paint_red" if i else "plastic_black", seg=12, M=T((tx, ty, top - 0.01)))
        else:                                                                 # iron heads
            bk.box(mb, (0.022, 0, 0.018), (0.075, 0.016, 0.046), "chrome", M=T((tx, ty, top)) @ RZ(a * 57.3) @ RY(-25))


def golf_cart(name, coll, loc=(0, 0, 0), yaw=0.0):
    """Two-seat cart: 2.4 x 1.2 x 1.83 m, 1.68 m wheelbase, 18x8.5-8 tyres. Front faces -Y."""
    mb = bk.MB()
    body = bk.MB()
    W = "paint_white"
    bk.box(mb, (0, 0.0, 0.27), (0.92, 2.25, 0.08), "plastic_black")                      # chassis tub
    bk.box(mb, (0, -0.22, 0.316), (1.0, 0.62, 0.012), "rubber_flat")                      # floor mat
    side_prism(mb, [(-1.17, 0.30), (-0.50, 0.30), (-0.50, 0.50), (-1.17, 0.50)], -0.36, 0.36, "plastic_black")
    side_prism(body, [(-1.20, 0.50), (-0.50, 0.50), (-0.50, 0.84), (-0.56, 0.875), (-0.66, 0.885), (-0.80, 0.865),
                      (-0.92, 0.83), (-1.03, 0.78), (-1.12, 0.71), (-1.17, 0.64), (-1.19, 0.57)], -0.57, 0.57, W,
               smooth=True)                         # front cowl
    bk.box(mb, (0, -0.475, 0.80), (1.08, 0.07, 0.15), "plastic_black")                    # dash
    for x in (-0.18, 0.18):
        bk.cyl(mb, (x, -0.455, 0.875), (x, -0.455, 0.80), 0.045, "plastic_black", seg=14)  # cup holders
    bk.beam(mb, (-0.56, -1.215, 0.40), (0.56, -1.215, 0.40), 0.06, 0.09, "plastic_black")  # front bumper
    for x in (-0.37, 0.37):
        bk.box(mb, (x, -1.178, 0.645), (0.16, 0.03, 0.065), "headlamp")
        bk.box(mb, (x, -1.165, 0.645), (0.19, 0.03, 0.095), "plastic_black")
    side_prism(mb, [(0.12, 0.30), (1.17, 0.30), (1.17, 0.50), (0.12, 0.50)], -0.36, 0.36, "plastic_black")
    side_prism(body, [(0.12, 0.50), (1.20, 0.50), (1.20, 0.60), (1.14, 0.645), (0.82, 0.665), (0.79, 0.74),
                      (0.12, 0.74)], -0.57, 0.57, W)                                         # seat pod + bag well
    bk.beam(mb, (-0.56, 1.215, 0.40), (0.56, 1.215, 0.40), 0.05, 0.08, "plastic_black")   # rear bumper
    bk.box(body, (0, 0.44, 0.805), (1.06, 0.54, 0.13), "vinyl")                             # seat
    bk.box(body, (0, 0, 0), (1.06, 0.11, 0.40), "vinyl", M=T((0, 0.78, 1.10)) @ RX(-9))     # backrest
    for x in (-0.42, 0.42):
        bk.cyl(mb, (x, 0.80, 0.72), (x, 0.84, 1.02), 0.016, "plastic_black", seg=8)
        bk.sweep(mb, [(x * 1.31, 0.30, 0.74), (x * 1.31, 0.30, 0.94), (x * 1.31, 0.62, 0.94), (x * 1.31, 0.62, 0.74)],
                 bk.circle(0.012, 8), "plastic_black", up=(1, 0, 0), smooth=True)          # hip restraints
    # canopy on four struts
    bk.box(body, (0, -0.02, 1.805), (1.18, 1.78, 0.06), W)
    bk.box(mb, (0, -0.02, 1.775), (1.08, 1.68, 0.025), "plastic_black")
    for x in (-0.53, 0.53):
        bk.cyl(mb, (x, -0.56, 0.86), (x, -0.84, 1.78), 0.017, "plastic_black", seg=10)
        bk.cyl(mb, (x, 0.90, 0.655), (x, 0.82, 1.78), 0.017, "plastic_black", seg=10)
    bk.cyl(mb, (-0.53, -0.84, 1.76), (0.53, -0.84, 1.76), 0.014, "plastic_black", seg=8)
    # steering
    p0, p1 = Vector((-0.27, -0.50, 0.86)), Vector((-0.27, -0.30, 1.04))
    bk.cyl(mb, p0, p1, 0.02, "plastic_black", seg=10)
    ax, ay, az = bk.basis_from_axis(p1 - p0)
    ring = [p1 + (ax * math.cos(a) + ay * math.sin(a)) * 0.165 for a in (math.tau * i / 18 for i in range(18))]
    bk.sweep(mb, ring, bk.circle(0.012, 8), "plastic_black", up=tuple(az), closed_path=True, smooth=True)
    for a in (R(90), R(210), R(330)):
        bk.beam(mb, p1, p1 + (ax * math.cos(a) + ay * math.sin(a)) * 0.16, 0.022, 0.012, "plastic_black", up=tuple(az))
    bk.cyl(mb, p1 - az * 0.01, p1 + az * 0.02, 0.04, "plastic_black", seg=12)
    for x in (-0.5, 0.5):
        for y in (-0.84, 0.84):
            _wheel(mb, (x, y, 0.23))
    # bag hoop + bag in the rear well
    bk.sweep(mb, [(-0.34, 0.95, 0.66), (-0.34, 1.0, 1.22), (0.34, 1.0, 1.22), (0.34, 0.95, 0.66)],
             bk.circle(0.013, 8), "chrome", up=(0, 1, 0), smooth=True)
    mb.push(T((0.02, 1.03, 0.655)) @ RX(8))
    _bag(mb)
    mb.pop()
    o = bk.obj_from_mb(mb, name, coll, loc=loc, bevel=(0.006, 2))
    o.rotation_euler = (0, 0, yaw)
    bk.grime_vcol(o.data, z0=0.0, height=0.5, strength=0.28)
    b = bk.obj_from_mb(body, name + "_Body", coll, parent=o, bevel=(0.022, 3))
    bk.grime_vcol(b.data, z0=0.0, height=0.5, strength=0.2)
    return o


# ------------------------------------------------------------------ trees
def tree_mesh(name, seed, H=14.0, trunk_r=0.3, depth=4, split=3, card=1.6, spread=(0.45, 0.95), tint=(1, 1, 1),
              game=False):
    """Broadleaf tree: recursive tapered branches, alpha leaf-cluster cards on the twigs, crown-space
    normals so the foliage shades as one volume, darker interior in vertex colour."""
    rng = np.random.default_rng(seed)
    mb = bk.MB()
    tips = []

    def branch(p, d, L, r, lvl):
        pts, dd = [Vector(p)], Vector(d)
        for _ in range(3):
            dd = (dd + Vector(rng.normal(0, 0.13, 3)) + Vector((0, 0, 0.07 if lvl else 0.0))).normalized()
            pts.append(pts[-1] + dd * (L / 3))
        rad = [r, r * 0.86, r * 0.74, r * 0.62]
        if lvl == 0:
            rad[0] = r * 1.35                                                  # root flare
        for i in range(3):
            if game and lvl >= depth:
                break                                                          # twigs hide inside the leaf cards
            bk.cyl(mb, pts[i], pts[i + 1], rad[i], "bark", seg=((7, 5, 4, 3, 3) if game else (10, 8, 6, 5, 4))[min(lvl, 4)],
                   r1=rad[i + 1], caps=False)
        if lvl >= depth:
            tips.extend(pts[1:])
            return
        if lvl >= depth - 2:
            tips.append(pts[-1])
        n = split + (1 if rng.random() < 0.4 else 0)
        for k in range(n):
            perp = dd.cross(Vector(rng.normal(0, 1, 3)))
            perp.normalize()
            cd = Quaternion(perp, rng.uniform(*spread)) @ dd
            start = pts[-1] if k % 2 == 0 else pts[2] + (pts[3] - pts[2]) * rng.uniform(0.0, 0.6)
            branch(start, cd, L * rng.uniform(0.62, 0.8), rad[-1] * rng.uniform(0.62, 0.8), lvl + 1)

    lean = Vector((rng.normal(0, 0.06), rng.normal(0, 0.06), 1.0)).normalized()
    branch((0, 0, -0.5), lean, H * 0.40, trunk_r, 0)
    centers = []
    for tp in tips:
        for _ in range(1 if game else 3):
            c = tp + Vector(rng.normal(0, 0.5, 3))
            q = Quaternion(Vector(rng.normal(0, 1, 3)).normalized(), rng.uniform(0, math.tau))
            s = card * (1.4 if game else 1.0) * rng.uniform(0.75, 1.25) / 2
            ax, ay = q @ Vector((s, 0, 0)), q @ Vector((0, s, 0))
            idx = [mb.v(c - ax - ay), mb.v(c + ax - ay), mb.v(c + ax + ay), mb.v(c - ax + ay)]
            mb.face(idx, "leaves", uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
            centers.append(c)
    me = mb.build(name, sharp_angle=None)
    li = next(i for i, m in enumerate(me.materials) if m.name == "M_Leaves")
    leaf_material()
    cc = np.mean(np.array([c[:] for c in centers]), 0)
    npoly = len(me.polygons)
    mi = np.empty(npoly, np.int32)
    me.polygons.foreach_get("material_index", mi)
    tot = np.empty(npoly, np.int32)
    me.polygons.foreach_get("loop_total", tot)
    pc = np.empty(npoly * 3)
    me.polygons.foreach_get("center", pc)
    pc = pc.reshape(-1, 3)
    co, lv = bk._loops(me)
    lp = np.repeat(np.arange(npoly), tot)
    is_leaf = (mi == li)[lp]
    nrm = np.empty(len(lv) * 3, np.float32)
    me.corner_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    out = co[lv] - cc
    out[:, 2] += 1.5
    out /= np.linalg.norm(out, axis=1, keepdims=True) + 1e-9
    nrm = np.where(is_leaf[:, None], out, nrm)
    me.normals_split_custom_set([tuple(v) for v in nrm.tolist()])
    dist = np.linalg.norm(pc - cc, axis=1)
    k = 0.6 + 0.4 * np.clip(dist / (dist[mi == li].max() + 1e-6), 0, 1) ** 1.3
    k *= 0.85 + 0.15 * np.clip((pc[:, 2] - cc[2]) / (H * 0.3) + 0.5, 0, 1)
    pr = np.random.default_rng(seed + 1).uniform(0.88, 1.1, (npoly, 3)) * np.array(tint)[None, :]
    col = np.where((mi == li)[:, None], k[:, None] * pr, 1.0)
    col = np.concatenate([np.clip(col, 0, 1), np.ones((npoly, 1))], 1)[lp]
    bk.ensure_vcol(me).data.foreach_set("color", col.astype(np.float32).ravel())
    me["height"] = float(co[:, 2].max())
    return me


# ------------------------------------------------------------------ river dressing
def log(name, coll, L=3.4, r=0.24, seed=1, loc=(0, 0, 0), yaw=0.0):
    """Drift log lying along Y, origin on its axis: tapered, slightly crooked, sawn ends, branch stubs."""
    rng = np.random.default_rng(seed)
    mb = bk.MB()
    n = 6
    pts = [Vector((rng.normal(0, 0.03), -L / 2 + L * i / n, rng.normal(0, 0.03))) for i in range(n + 1)]
    rad = [r * (1 - 0.28 * i / n) * rng.uniform(0.94, 1.06) for i in range(n + 1)]
    for i in range(n):
        r0, r1 = bk.cyl(mb, pts[i], pts[i + 1], rad[i], "bark", seg=12, r1=rad[i + 1], caps=False, hint=(0, 0, 1))
        if i == 0:
            mb.face(list(reversed(r0)), "wood", smooth=False)
        if i == n - 1:
            mb.face(r1, "wood", smooth=False)
    for _ in range(3):
        i = int(rng.integers(1, n))
        a = rng.uniform(0, math.tau)
        d = Vector((math.cos(a), rng.uniform(-0.4, 0.4), math.sin(a))).normalized()
        p = pts[i] + d * rad[i] * 0.7
        bk.cyl(mb, p, p + d * rng.uniform(0.2, 0.5), rng.uniform(0.045, 0.07), "bark", seg=7, r1=0.035, cap_mat="wood")
    o = bk.obj_from_mb(mb, name, coll, loc=loc, sharp=45.0)
    o.rotation_euler = (0, 0, yaw)
    bk.grime_vcol(o.data, z0=-r, height=r * 1.6, strength=0.45)          # waterlogged underside
    return o


GATOR = [(-1.62, .055, .030, .020), (-1.45, .085, .050, .035), (-1.15, .105, .060, .045), (-1.00, .14, .10, .06),
         (-0.85, .17, .12, .08), (-0.60, .21, .14, .10), (-0.20, .28, .17, .13), (0.30, .29, .18, .13),
         (0.70, .24, .16, .11), (1.00, .16, .14, .08), (1.40, .10, .12, .05), (1.80, .055, .10, .03), (2.15, .012, .05, .01)]


def gator(name, coll, loc=(0, 0, 0), yaw=0.0):
    """3.8 m alligator, head towards -Y, origin at the waterline: scutes, eye bumps, teeth, splayed legs."""
    mb = bk.MB()
    ys = [s[0] for s in GATOR]
    seg = 14
    rings = []
    for y, w, ht, hb in GATOR:
        ring = []
        for i in range(seg):
            a = math.tau * i / seg
            c, s = math.cos(a), math.sin(a)
            ring.append(mb.v((w * math.copysign(abs(c) ** 0.7, c), y, (ht if s > 0 else hb) * math.copysign(abs(s) ** 0.8, s))))
        rings.append(ring)
    for a, b in zip(rings[:-1], rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            mb.face([a[i], b[i], b[j], a[j]], "gator")
    mb.face(rings[0], "gator")
    mb.face(list(reversed(rings[-1])), "gator")

    def at(y):
        return (float(np.interp(y, ys, [s[1] for s in GATOR])), float(np.interp(y, ys, [s[2] for s in GATOR])))
    for y in np.arange(-0.75, 2.0, 0.105):                                # scutes: two rows, one on the tail
        w, ht = at(y)
        for x in ((-0.42 * w, 0.42 * w) if w > 0.11 else (0.0,)):
            bk.cyl(mb, (x, y, ht * 0.9), (x, y + 0.02, ht * 0.9 + 0.045 + 0.02 * (w < 0.11)), 0.032, "gator", seg=4, r1=0.003)
    for sx in (-1, 1):
        bk.lathe(mb, [(0.0005, -0.035), (0.03, -0.02), (0.04, 0.0), (0.03, 0.025), (0.0005, 0.035)], "gator", seg=10,
                 M=T((sx * 0.085, -0.97, 0.10)))                           # brow bumps
        bk.lathe(mb, [(0.0005, -0.018), (0.015, -0.01), (0.019, 0.0), (0.015, 0.01), (0.0005, 0.018)], "gator_eye", seg=10,
                 M=T((sx * 0.108, -0.985, 0.118)))
        bk.lathe(mb, [(0.0005, -0.012), (0.014, 0.0), (0.0005, 0.012)], "gator", seg=8, M=T((sx * 0.03, -1.56, 0.035)))
        for y in np.arange(-1.58, -1.03, 0.045):                           # teeth
            w, _ = at(y)
            bk.cyl(mb, (sx * (w - 0.006), y, 0.004), (sx * (w - 0.002), y, -0.028), 0.0075, "tooth", seg=5, r1=0.001)
        for y, reach in ((-0.45, 0.24), (0.55, 0.27)):                     # legs
            w, _ = at(y)
            bk.beam(mb, (sx * w * 0.8, y, -0.03), (sx * (w + reach), y + 0.07, -0.13), 0.10, 0.085, "gator")
            bk.box(mb, (sx * (w + reach + 0.04), y + 0.02, -0.15), (0.16, 0.20, 0.045), "gator")
    o = bk.obj_from_mb(mb, name, coll, loc=loc, sharp=42.0)
    o.rotation_euler = (0, 0, yaw)
    bk.grime_vcol(o.data, z0=-0.16, height=0.22, strength=0.4)
    return o


def bridge(name, coll, L=24.0, W=2.6, loc=(0, 0, 0), yaw=0.0):
    """Timber cart bridge along +Y from the origin, deck top at z = 0: stringers, planks, rails, piles."""
    mb = bk.MB()
    for x in (-W / 2 + 0.3, W / 2 - 0.3):
        bk.beam(mb, (x, 0, -0.19), (x, L, -0.19), 0.14, 0.30, "wood")
        for y in (L * 0.3, L * 0.7):
            bk.cyl(mb, (x, y, -3.0), (x, y, -0.34), 0.13, "wood", seg=10)
    for y in (L * 0.3, L * 0.7):
        bk.beam(mb, (-W / 2 + 0.05, y, -0.42), (W / 2 - 0.05, y, -0.42), 0.16, 0.16, "wood")
    n = int(L / 0.16)
    for i in range(n):
        bk.box(mb, (0, (i + 0.5) * L / n, -0.02), (W, L / n - 0.02, 0.04), "wood")
    np_ = int(L / 2.4) + 1
    for sx in (-1, 1):
        x = sx * (W / 2 - 0.06)
        for i in range(np_):
            bk.box(mb, (x, 0.08 + i * (L - 0.16) / (np_ - 1), 0.52), (0.10, 0.10, 1.12), "wood")
        bk.beam(mb, (x, 0, 1.07), (x, L, 1.07), 0.12, 0.05, "wood")
        bk.beam(mb, (x, 0.05, 0.58), (x, L - 0.05, 0.58), 0.04, 0.09, "wood")
    o = bk.obj_from_mb(mb, name, coll, loc=loc, bevel=(0.008, 1))
    o.rotation_euler = (0, 0, yaw)
    bk.grime_vcol(o.data, z0=-3.0, height=2.8, strength=0.45)
    return o
