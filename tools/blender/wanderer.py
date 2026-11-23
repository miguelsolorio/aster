"""Build public/art/wanderer.glb: the modelled cloth, hood, limbs, hands and shoes of the wanderer
(src/game/figure.ts). Everything is procedural; figure.ts keeps its own geometry as the fallback and
swaps these meshes in when the file arrives.

Coordinates below are written in the game's space (three.js: +y up, the figure faces +z, feet at
y = 0) and converted to Blender's on the way in; the exporter converts back (+Y up).

Export conventions, per object:
  Dress, Cloak, HoodRim, HoodPoint   figure space (feet at y = 0)
  LegUpper                           hip pivot space (hangs from 0 to -THIGH)
  LegLower, Shoe                     knee pivot space
  ArmLimb                            unit length, 0 to -1, at full thickness (figure.ts scales it)
  Hand                               wrist space, hanging down from the wrist at 0
Dress and Cloak carry the point attribute _AUV (arrives in three.js as `_auv`): x -1..1 the angle
round the body (0 = front, from atan2(x, z) of the rest shape), y 0 collar .. 1 hem.

Run:  blender --background --python tools/blender/wanderer.py [-- --preview <dir>]
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "art", "wanderer.glb")

# --- the figure's measurements (keep in step with figure.ts)
HIP = 0.78
THIGH = 0.39
SHIN = 0.39
COLLAR = 1.42
HEM = 0.4
HEAD_Y = 1.55
HEAD_R = 0.125
HOOD_R = 0.155
HOOD_Y = HEAD_Y + 0.01
HOOD_Z = -0.03
FACE_DROP = 0.11
FACE_COS = 0.6
SHOULDER_Y = 1.3 - HIP

DRESS = dict(top=COLLAR, hem=HEM, r0=0.07, r1=0.33, curve=1.45, arc=math.pi, rag=0.06, flat=0.88)
CLOAK = dict(top=COLLAR + 0.03, hem=0.74, r0=0.1, r1=0.27, curve=0.75, arc=2.35, rag=0.05, flat=0.92)


def bl(p):
    """Game space (x, y up, z forward) to Blender space (x, y back, z up)."""
    return (p[0], -p[2], p[1])


def smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def make_object(name, verts, faces, auv=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([bl(v) for v in verts], [], faces)
    me.validate()
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    if auv is not None:
        at = me.attributes.new("_AUV", "FLOAT2", "POINT")
        for i, uv in enumerate(auv):
            at.data[i].vector = uv
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def grid_faces(rows, cols, closed_cols=False):
    """Quads over a rows x cols vertex grid (row-major)."""
    faces = []
    nc = cols if closed_cols else cols - 1
    for j in range(rows - 1):
        for i in range(nc):
            a = j * cols + i
            b = j * cols + (i + 1) % cols
            c = a + cols
            d = b + cols
            faces.append((a, b, d, c))
    return faces


# ------------------------------------------------------------------ the two drapes


def pleat(phase):
    """A fold profile: rounded ridges, narrower, sharper valleys."""
    f = math.cos(phase)
    return f if f > 0 else -((-f) ** 0.55)


def drape(name, d, NU, NV, phase_fn, amp_fn, depth_fn, extra_fn, collar=None, roll=None):
    top, hem, r0, r1, curve, arc, rag, flat = (d[k] for k in ("top", "hem", "r0", "r1", "curve", "arc", "rag", "flat"))
    closed = arc >= math.pi - 1e-3

    def point(u, v):
        a = (u * 2 - 1) * arc
        drop = 0.0 if closed else 0.1 * v * (0.5 - 0.5 * math.cos(a))
        r = r0 + (r1 - r0) * v ** curve
        pf = pleat(phase_fn(a)) * amp_fn(a)
        r += pf * depth_fn(v) + extra_fn(a, v)
        # soft scallops at the hem, seven round the cloth, worked into the last rows
        sc = rag * (0.5 + 0.5 * math.sin(u * math.pi * 14 + top * 10))
        y = top - v * (top - hem) - drop - sc * smooth(0.78, 1.0, v) ** 1.5
        # the valleys of the folds hang a touch lower than the ridges
        y -= 0.007 * max(0.0, -pf) * v * v
        return a, Vector((math.sin(a) * r, y, math.cos(a) * r * flat))

    rows = []  # each row: list of (position, v)
    cols = NU + 1
    # a soft rolled collar above the top row (the cloak): turns out and down over the shoulders
    if collar:
        for dr, dy in collar:
            row = []
            for i in range(cols):
                u = i / NU
                a, p = point(u, 0.0)
                s = smooth(0.9, 1.9, abs(a))
                n = Vector((math.sin(a), 0, math.cos(a) * flat)).normalized()
                row.append((p + n * (dr * s) + Vector((0, dy * s, 0)), 0.0))
            rows.append(row)
    for j in range(NV + 1):
        v = j / NV
        rows.append([(point(i / NU, v)[1], v) for i in range(cols)])
    # a thickened hem: the edge rolled outward and back up a little
    if roll:
        last = rows[-1]
        prev = rows[-2]
        for dr, dy in roll:
            row = []
            for i in range(cols):
                p = last[i][0]
                a = (i / NU * 2 - 1) * arc
                n = Vector((math.sin(a), 0, math.cos(a) * flat)).normalized()
                # follow the cloth's own slope at the hem so the roll sits square to it
                down = (p - prev[i][0]).normalized()
                row.append((p + n * dr - down * dy, 1.0))
            rows.append(row)

    verts = []
    auv = []
    for row in rows:
        for p, v in row:
            verts.append(tuple(p))
            # aUV from the rest shape: the angle from atan2(x, z) (z unsquashed), v as built
            ang = math.atan2(p.x, p.z / flat) / math.pi
            auv.append((max(-1.0, min(1.0, ang)), v))
    # (the closed dress keeps its seam at the back as two columns, so aUV.x never wraps across a face)
    if closed:
        n = len(rows)
        for j in range(n):
            auv[j * cols] = (-1.0, auv[j * cols][1])
            auv[j * cols + NU] = (1.0, auv[j * cols + NU][1])
    faces = grid_faces(len(rows), cols)
    return make_object(name, verts, faces, auv)


def build_dress():
    # nine irregular pleats; the irregularity is in the phase, so the dress stays closed
    phase = lambda a: 9 * a + 0.55 * math.sin(2 * a + 0.7) + 0.35 * math.sin(3 * a + 2.1) + 0.2 * math.sin(5 * a + 0.3)
    amp = lambda a: 1 + 0.35 * math.sin(3 * a + 1.3) + 0.2 * math.sin(5 * a + 0.4)
    WAIST = (DRESS["top"] - 1.02) / (DRESS["top"] - DRESS["hem"])  # v at the sash

    def depth(v):
        # barely there on the bodice, gathered in at the sash, deepening to the hem
        above = 0.0025 * smooth(0.0, WAIST, v)
        below = 0.004 + 0.042 * max(0.0, (v - WAIST) / (1 - WAIST)) ** 1.2
        return above if v < WAIST else above * (1 - smooth(WAIST, WAIST + 0.08, v)) + below * smooth(WAIST - 0.02, WAIST + 0.06, v)

    def extra(a, v):
        # the gathered waistband: a soft raised band under the sash, crimped by small gathers
        band = math.exp(-(((v - WAIST) / 0.035) ** 2))
        return band * (0.005 + 0.0025 * math.cos(30 * a))

    return drape("Dress", DRESS, 96, 26, phase, amp, depth, extra, roll=[(0.006, -0.002), (0.011, 0.004), (0.009, 0.011)])


def build_cloak():
    # fewer, broader folds: about five across the cloak's width
    phase = lambda a: 6.4 * a + 0.5 * math.sin(1.3 * a + 0.4) + 0.3 * math.sin(2.7 * a + 1.9)
    amp = lambda a: 1 + 0.3 * math.sin(2.1 * a + 0.5)
    YOKE = 0.24

    def depth(v):
        # the yoke lies smooth over the shoulders; below it the folds open and deepen
        return 0.003 + 0.05 * smooth(YOKE - 0.04, 1.0, v) ** 0.9

    def extra(a, v):
        # a squarer shoulder under the yoke and a soft seam ridge where the yoke ends
        shoulder = 0.012 * math.sin(a) ** 2 * math.exp(-(((v - 0.16) / 0.1) ** 2))
        seam = 0.0035 * math.exp(-(((v - YOKE) / 0.018) ** 2))
        return shoulder + seam

    collar = [(0.03, -0.016), (0.038, 0.0), (0.03, 0.014), (0.014, 0.019), (0.003, 0.01)]
    return drape("Cloak", CLOAK, 80, 22, phase, amp, depth, extra, collar=collar, roll=[(0.005, -0.002), (0.01, 0.004), (0.008, 0.01)])


# ------------------------------------------------------------------ the hood

C = Vector((0, HOOD_Y, HOOD_Z))
AX = Vector((0, -FACE_DROP, 1)).normalized()
E1 = Vector((1, 0, 0))
E2 = AX.cross(E1).normalized()  # "up", square to the face axis
HEAD_O = Vector((0, HEAD_Y - HOOD_Y, 0.035 - HOOD_Z))


def surf(dirn):
    """How far from the hood's centre the outside of hood or head lies in this direction."""
    th = HOOD_R / Vector((dirn.x, dirn.y / 1.03, dirn.z)).length
    b = dirn.dot(HEAD_O)
    disc = b * b - (HEAD_O.length_squared - HEAD_R * HEAD_R)
    tk = b + math.sqrt(max(disc, 0.0))
    return max(th, tk)


def cone_dir(theta, phi):
    return (AX * math.cos(theta) + (E1 * math.cos(phi) + E2 * math.sin(phi)) * math.sin(theta)).normalized()


def build_hood_rim():
    """A soft thick roll framing the face, sitting just outside the face circle."""
    NP, NS = 64, 12
    tf = math.acos(FACE_COS)
    verts = []
    for i in range(NP):
        phi = i / NP * 2 * math.pi
        up = 0.5 + 0.5 * math.sin(phi)
        rho = 0.008 + 0.014 * up ** 1.3  # thick over the brow, slimmer at the sides, thin under the chin
        tc = tf + rho / 0.17 + 0.05
        dc = cone_dir(tc, phi)
        dist = surf(dc) + 0.25 * rho
        cen = dc * dist
        t_dir = (cone_dir(tc + 0.01, phi) * dist - cen).normalized()  # toward the back of the hood
        for k in range(NS):
            psi = k / NS * 2 * math.pi
            off = dc * (math.cos(psi) * rho * 0.85) + t_dir * (math.sin(psi) * rho * 1.1)
            verts.append(tuple(C + cen + off))
    faces = []
    for i in range(NP):
        for k in range(NS):
            a = i * NS + k
            b = i * NS + (k + 1) % NS
            c = ((i + 1) % NP) * NS + k
            d = ((i + 1) % NP) * NS + (k + 1) % NS
            faces.append((a, c, d, b))
    return make_object("HoodRim", verts, faces)


def loft(name, path, radii, NS=12, rw=None, cap_end=True, cap_start=True, side=(1, 0, 0)):
    """A tube along a polyline: radii per point across `side`, rw (default the same) square to it."""
    rw = rw or radii
    verts = []
    n = len(path)
    sv = Vector(side)
    for j in range(n):
        p = Vector(path[j])
        t = (Vector(path[min(j + 1, n - 1)]) - Vector(path[max(j - 1, 0)])).normalized()
        s = (sv - t * sv.dot(t)).normalized()
        w = t.cross(s).normalized()
        for k in range(NS):
            q = k / NS * 2 * math.pi
            verts.append(tuple(p + s * (math.cos(q) * radii[j]) + w * (math.sin(q) * rw[j])))
    faces = grid_faces(n, NS, closed_cols=True)
    if cap_start:
        verts.append(tuple(path[0]))
        c = len(verts) - 1
        faces += [(c, (k + 1) % NS, k) for k in range(NS)]
    if cap_end:
        verts.append(tuple(path[-1]))
        c = len(verts) - 1
        base = (n - 1) * NS
        faces += [(c, base + k, base + (k + 1) % NS) for k in range(NS)]
    return make_object(name, verts, faces)


def catmull(ctrl, per=6):
    """A smooth curve through the control points (Catmull-Rom), per samples a span."""
    pts = []
    P = [Vector(c) for c in ctrl]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    for i in range(1, len(P) - 2):
        for k in range(per):
            t = k / per
            a, b, c, d = P[i - 1], P[i], P[i + 1], P[i + 2]
            pts.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
    pts.append(P[-2])
    return pts


def build_hood_point():
    """The hood's short point: it lifts a little behind the crown, then folds over and hangs down
    the back of the hood as a flat flap of cloth, narrow seen from behind, to a soft tip above the nape."""
    ctrl = [(0, 0.06, -0.07), (0, 0.105, -0.125), (0, 0.07, -0.165), (0, 0.0, -0.165), (0, -0.07, -0.155), (0, -0.125, -0.132)]
    rx = [0.08, 0.058, 0.045, 0.034, 0.02, 0.003]  # across the back
    rw = [0.08, 0.05, 0.044, 0.04, 0.03, 0.004]  # its depth, out from the hood
    path = catmull(ctrl)
    per = 6

    def along(rs, i):
        f = min(i / per, len(rs) - 1.0001)
        k = int(f)
        return rs[k] + (rs[k + 1] - rs[k]) * (f - k)

    pts = [tuple(C + p) for p in path]
    return loft("HoodPoint", pts, [along(rx, i) for i in range(len(path))], NS=14, rw=[along(rw, i) for i in range(len(path))])


# ------------------------------------------------------------------ limbs, hands and shoes


def build_limb(name, length, r_top, r_bot, bulge=0.0, bulge_at=0.3, flare=0.0, sides=10, rows=10):
    path, rad = [], []
    for j in range(rows + 1):
        s = j / rows
        r = r_top + (r_bot - r_top) * s + bulge * math.exp(-(((s - bulge_at) / 0.22) ** 2)) + flare * smooth(0.85, 1.0, s)
        path.append((0, -length * s, 0))
        rad.append(r)
    return loft(name, path, rad, NS=sides, side=(1, 0, 0))


def subdivided_box(bm, centre, size, taper=1.0, rot=None):
    res = bmesh.ops.create_cube(bm, size=1.0)
    vs = res["verts"]
    for v in vs:
        x, y, z = v.co.x, v.co.y, v.co.z  # Blender space cube
        k = 1 + (taper - 1) * (0.5 - z)  # narrower toward the cube's -z end (game: the fingertips)
        v.co = Vector((x * size[0] * k, y * size[2] * k, z * size[1]))
        if rot:
            v.co = rot @ v.co
        v.co += Vector(bl(centre))
    return vs


def build_hand():
    """A mitten: a soft flat paddle hanging from the wrist, a thumb nub toward the front."""
    me = bpy.data.meshes.new("Hand")
    bm = bmesh.new()
    subdivided_box(bm, (0, -0.033, 0.002), (0.024, 0.062, 0.04), taper=0.85)
    subdivided_box(bm, (0, -0.02, 0.021), (0.016, 0.03, 0.016), rot=Matrix.Rotation(-0.5, 3, "X"))
    # a little cuff where it meets the sleeve
    subdivided_box(bm, (0, -0.004, 0.0), (0.03, 0.014, 0.034))
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new("Hand", me)
    bpy.context.scene.collection.objects.link(ob)
    m = ob.modifiers.new("soft", "SUBSURF")
    m.levels = m.render_levels = 2
    return ob


def build_shoe():
    """Wrapped-cloth shoes: a soft rounded foot with a flat sole and spiral wraps up the ankle."""
    y0 = -SHIN - 0.004
    NZ, NB = 22, 16
    z0, z1 = -0.038, 0.118
    verts = []
    for j in range(NZ + 1):
        s = j / NZ
        z = z0 + (z1 - z0) * s
        end = math.sqrt(max(0.0, 1 - (2 * s - 1) ** 6))  # round the heel and toe
        w = 0.029 * (0.82 + 0.18 * math.sin(s * math.pi * 0.9 + 0.2)) * end
        h = (0.056 - 0.026 * smooth(0.25, 0.85, s)) * (0.35 + 0.65 * end)
        for k in range(NB):
            q = k / NB * 2 * math.pi
            x = math.sin(q) * w
            y = y0 + h * 0.5 - math.cos(q) * h * 0.5
            y = max(y, y0)
            # the wraps: low spiral ridges across the top of the foot
            if y > y0 + 0.012:
                rid = 0.0022 * max(0.0, math.sin(2 * math.pi * (5.5 * s + 0.6 * q / math.pi)))
                x += math.sin(q) * rid
                y += max(0.0, -math.cos(q)) * rid
            verts.append((x, y, z))
    faces = grid_faces(NZ + 1, NB, closed_cols=True)
    # close heel and toe
    verts.append((0, y0 + 0.01, z0))
    c = len(verts) - 1
    faces += [(c, (k + 1) % NB, k) for k in range(NB)]
    verts.append((0, y0 + 0.01, z1))
    c2 = len(verts) - 1
    base = NZ * NB
    faces += [(c2, base + k, base + (k + 1) % NB) for k in range(NB)]
    ob = make_object("Shoe", verts, faces)
    # the ankle wrap, a short tapered spiral-bound sleeve round the bottom of the shin
    path, rad = [], []
    for j in range(13):
        s = j / 12
        path.append((0, y0 + 0.02 + 0.075 * s, -0.004 + 0.004 * s))
        rad.append(0.027 - 0.005 * s + 0.0018 * math.sin(s * math.pi * 7))
    ank = loft("ShoeAnkle", path, rad, NS=12)
    # one mesh: join the wrap into the shoe
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    ank.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    return ob


# ------------------------------------------------------------------ build and export


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def tri_count(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = ob.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    ob.evaluated_get(dg).to_mesh_clear()
    return n


def main():
    clear()
    parts = [
        build_dress(),
        build_cloak(),
        build_hood_rim(),
        build_hood_point(),
        build_limb("LegUpper", THIGH, 0.031, 0.024, bulge=0.003, bulge_at=0.25),
        build_limb("LegLower", SHIN - 0.01, 0.025, 0.017, bulge=0.003, bulge_at=0.3),
        build_limb("ArmLimb", 1.0, 0.021, 0.016, bulge=0.0015, bulge_at=0.15, flare=0.003, sides=8),
        build_hand(),
        build_shoe(),
    ]
    bpy.ops.object.select_all(action="DESELECT")
    for ob in parts:
        ob.select_set(True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_attributes=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="NONE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    for ob in parts:
        print(f"WANDERER {ob.name}: {tri_count(ob)} triangles")
    print(f"WANDERER wrote {os.path.abspath(OUT)} ({os.path.getsize(OUT)} bytes)")
    return parts


# ------------------------------------------------------------------ preview renders (not exported)


def place(ob, loc, rot=None):
    """Move a part (made in its pivot space) to a pivot in game space."""
    m = Matrix.Translation(Vector(bl(loc)))
    if rot is not None:
        m = m @ rot
    ob.matrix_world = m


def render_previews(parts, out_dir):
    by = {o.name: o for o in parts}
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene

    def mat(name, col):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        b.inputs["Base Color"].default_value = (*col, 1)
        b.inputs["Roughness"].default_value = 0.9
        return m

    dress_m = mat("dress", (0.035, 0.03, 0.028))
    cloak_m = mat("cloak", (0.07, 0.058, 0.05))
    # the hood sphere and head, with the face drawn as the shader does: white within the cone
    face_m = bpy.data.materials.new("face")
    face_m.use_nodes = True
    nt = face_m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.07, 0.058, 0.05, 1)
    bsdf.inputs["Roughness"].default_value = 0.9
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    white = nt.nodes.new("ShaderNodeBsdfDiffuse")
    white.inputs["Color"].default_value = (0.95, 0.93, 0.88, 1)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nrm = nt.nodes.new("ShaderNodeVectorMath")
    nrm.operation = "NORMALIZE"
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = Vector(bl(AX))
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = FACE_COS
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(tc.outputs["Object"], nrm.inputs[0])
    nt.links.new(nrm.outputs["Vector"], dot.inputs[0])
    nt.links.new(dot.outputs["Value"], gt.inputs[0])
    nt.links.new(gt.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(bsdf.outputs[0], mix.inputs[1])
    nt.links.new(white.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])

    def sphere(name, r, yscale, offset):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=32, radius=r)
        for v in bm.verts:
            v.co.z *= yscale
            v.co += Vector(bl(offset))
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        ob.location = Vector(bl(C))
        ob.data.materials.append(face_m)
        return ob

    hood = sphere("PHood", HOOD_R, 1.03, (0, 0, 0))
    sphere("PHead", HEAD_R, 1.0, tuple(HEAD_O))
    tc.object = hood

    by["Dress"].data.materials.append(dress_m)
    for n in ("Cloak", "HoodRim", "HoodPoint"):
        by[n].data.materials.append(cloak_m)
    # limbs, standing, plus the arms spread as on the glide so the hands show
    legs = []
    for sx in (-1, 1):
        for name, loc in (("LegUpper", (sx * 0.065, HIP, 0)), ("LegLower", (sx * 0.065, HIP - THIGH, 0)), ("Shoe", (sx * 0.065, HIP - THIGH, 0))):
            o = by[name].copy()
            o.data = by[name].data
            sc.collection.objects.link(o)
            o.data.materials.clear()
            o.data.materials.append(dress_m)
            place(o, loc)
            legs.append(o)
    for n in ("LegUpper", "LegLower", "Shoe"):
        by[n].hide_render = True
    arm_len = 0.44
    for sx in (-1, 1):
        sh = Vector((sx * 0.09, SHOULDER_Y + HIP, 0))
        tgt = Vector((sx * 0.52, 0.44 + HIP, -0.06))
        d = (tgt - sh)
        ln = d.length
        q = Vector(bl((0, -1, 0))).rotation_difference(Vector(bl(d / ln))).to_matrix().to_4x4()
        a = by["ArmLimb"].copy()
        a.data = by["ArmLimb"].data
        sc.collection.objects.link(a)
        a.data.materials.clear()
        a.data.materials.append(dress_m)
        a.matrix_world = Matrix.Translation(Vector(bl(sh))) @ q @ Matrix.Diagonal((1, 1, ln, 1))  # Blender z = game y
        h = by["Hand"].copy()
        h.data = by["Hand"].data
        sc.collection.objects.link(h)
        h.data.materials.clear()
        h.data.materials.append(dress_m)
        h.matrix_world = Matrix.Translation(Vector(bl(sh + d))) @ q
    by["ArmLimb"].hide_render = True
    by["Hand"].hide_render = True
    del arm_len

    # ground, light, sky
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(mat("sand", (0.72, 0.55, 0.36)))
    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.8, 0.66, 0.5, 1)
    bg.inputs["Strength"].default_value = 0.6
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.5
    sun.angle = 0.1
    so = bpy.data.objects.new("sun", sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(35))

    cam = bpy.data.cameras.new("cam")
    cam.lens = 85
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    try:
        sc.render.engine = "CYCLES"
        sc.cycles.samples = 24
        sc.cycles.device = "CPU"
    except (TypeError, AttributeError):
        pass
    sc.render.resolution_x = 520
    sc.render.resolution_y = 760
    sc.render.film_transparent = False
    try:
        sc.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    target = Vector(bl((0, 0.95, 0)))
    views = {"front": (0, 0.0), "side": (90, 0.0), "back": (180, 0.0), "three": (35, 8.0), "face": (0, 0.0)}
    for name, (yaw, pitch) in views.items():
        dist = 7.0
        tg = target
        if name == "face":
            dist = 2.4
            tg = Vector(bl((0, 1.45, 0)))
        a = math.radians(yaw)
        p = math.radians(pitch)
        eye = (math.sin(a) * math.cos(p) * dist, 0.95 + math.sin(p) * dist, math.cos(a) * math.cos(p) * dist)
        co.location = Vector(bl(eye)) + (tg - target)
        dirn = tg - co.location
        co.rotation_euler = dirn.to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out_dir, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"WANDERER render {sc.render.filepath}")


if __name__ == "__main__":
    built = main()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--preview" in argv:
        render_previews(built, argv[argv.index("--preview") + 1])
