"""The townsfolk: one mesh holding every silhouette of src/city/people.ts, exported to
public/art/townsfolk.glb.

    blender --background --python tools/blender/townsfolk.py               # write the .glb
    blender --background --python tools/blender/townsfolk.py -- --preview DIR   # and render each silhouette

Everything is built in the game's own frame (metres, +Y up, feet at 0, facing +Z) and turned into
Blender's Z-up frame only when the mesh is made, so the exporter's +Y-up conversion gives back
exactly these numbers. Each vertex carries the two attributes the crowd's vertex shader reads:

  _apart (aPart)  x: 0 robe, 1 head and headwear, 2/3 legs, 4 cane;  y: shade multiplier
  _akind (aKind)  x: 0 cloth, 1 white face, 2 dark;  y: silhouette (0..3, -1 all, -2 all but the
                  tall hood);  z: robe height 0 hem .. 1 neck, or -1 for a vertex placed as is

A vertex with aKind.z >= 0 is robe-relative: the shader puts it at height robe(z).y and multiplies
its x and z by the silhouette's robe radius there, so its x/z here are multipliers of that radius
(pleats, flare, shoulders). Everything else is placed in metres. The silhouettes:
  0 the wide robe with a draped headcloth and cord,  1 the narrow robe with a tall pointed hood,
  2 the bent elder in a soft cowl, with a cane,  3 the straight robe with a tall wound turban.
Winding is counter-clockwise seen from outside (the material culls back faces).
"""

import math
import os
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "townsfolk.glb"))
SHAPES = 4

# ---------------------------------------------------------------- the shader's robe, mirrored


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


def robe(v, s):
    """people.ts robe(): radius, height, forward offset of the robe at height v for silhouette s."""
    if s == 0:
        return mix(0.36, 0.085, v ** 0.85), mix(0.3, 1.42, v), 0.0
    if s == 1:
        return mix(0.25, 0.085, v * (0.5 + 0.5 * v)), mix(0.2, 1.42, v), 0.0
    if s == 2:
        return 0.28 * (1 - 0.7 * v * v * v), mix(0.34, 1.18, v), 0.11 * v * v
    return mix(0.21, 0.185, v) * (1 - 0.52 * smoothstep(0.78, 1.0, v)), mix(0.18, 1.42, v), 0.0


def robe_v(y, s):
    """The robe height v at which silhouette s reaches height y."""
    y0, y1 = {0: (0.3, 1.42), 1: (0.2, 1.42), 2: (0.34, 1.18), 3: (0.18, 1.42)}[s]
    return (y - y0) / (y1 - y0)


def lerp_table(tab, v):
    if v <= tab[0][0]:
        return tab[0][1]
    for (a, x), (b, y) in zip(tab, tab[1:]):
        if v <= b:
            return mix(x, y, (v - a) / (b - a))
    return tab[-1][1]


# shoulders: the robe widens across (x) and a little front to back (z) just below the neck
SHOULDER_X = [(0.6, 1.0), (0.72, 1.07), (0.82, 1.24), (0.88, 1.4), (0.92, 1.44), (0.965, 1.28), (1.0, 1.0)]
SHOULDER_Z = [(0.6, 1.0), (0.82, 1.07), (0.9, 1.13), (0.965, 1.08), (1.0, 1.0)]
PLEATS = 6
N_ROBE = 18


def pleat_depth(v):
    return 0.15 * max(0.0, 1 - v / 0.8) ** 1.4


def robe_mul(a, v):
    """Radius multipliers (x, z) of the robe surface at angle a (0 = front, +x at pi/2) and height v."""
    m = 1 + pleat_depth(v) * math.cos(PLEATS * a)
    m *= 1 + 0.075 * max(0.0, 1 - v / 0.13) ** 2  # the hem flares
    h = max(0.0, 1 - v / 0.2)  # and is not a perfect circle
    m *= 1 + h * (0.035 * math.sin(2 * a + 1.3) + 0.025 * math.sin(3 * a + 0.4))
    return m * lerp_table(SHOULDER_X, v), m * lerp_table(SHOULDER_Z, v)


def robe_point(a, v, s, out=0.0):
    """Where the robe surface of silhouette s is at angle a, height v (metres), pushed out by `out`."""
    r, y, oz = robe(v, s)
    mx, mz = robe_mul(a, v)
    return (math.sin(a) * (mx * r + out), y, math.cos(a) * (mz * r * 0.86 + out) + oz)


# ---------------------------------------------------------------- mesh building


class Builder:
    def __init__(self):
        self.pos = []
        self.part = []
        self.kind = []
        self.tri = []
        self.pid = 0
        self.mat = 0
        self.who = -1
        self.shade = 1.0

    def vert(self, p, v=-1.0):
        self.pos.append(tuple(p))
        self.part.append((self.pid, self.shade))
        self.kind.append((self.mat, self.who, v))
        return len(self.pos) - 1

    def ring(self, pts, v=-1.0):
        base = len(self.pos)
        for p in pts:
            self.vert(p, v)
        return base

    def band(self, r0, r1, n):
        for k in range(n):
            k1 = (k + 1) % n
            self.tri += [(r0 + k, r0 + k1, r1 + k), (r0 + k1, r1 + k1, r1 + k)]

    def strip(self, r0, r1, n):
        """An open band (n points per row, not closed round)."""
        for k in range(n - 1):
            self.tri += [(r0 + k, r0 + k + 1, r1 + k), (r0 + k + 1, r1 + k + 1, r1 + k)]

    def fan(self, r, c, flip, n):
        for k in range(n):
            k1 = (k + 1) % n
            self.tri.append((r + k1, r + k, c) if flip else (r + k, r + k1, c))

    def loft(self, rings, bottom=None, top=None, v=-1.0):
        """Rings of points (bottom to top, each counter-clockwise seen from above starting at the
        front), closed by optional poles."""
        n = len(rings[0])
        ids = [self.ring(r, v) for r in rings]
        for a, b in zip(ids, ids[1:]):
            self.band(a, b, n)
        if bottom is not None:
            self.fan(ids[0], self.vert(bottom, v), True, n)
        if top is not None:
            self.fan(ids[-1], self.vert(top, v), False, n)
        return ids

    def ball(self, c, rx, ry, rz, n=8, rows=4, fn=None):
        rings = []
        for j in range(1, rows + 1):
            a = j / (rows + 1) * math.pi
            y = c[1] - math.cos(a) * ry
            pts = []
            for k in range(n):
                t = k / n * TAU
                p = [c[0] + math.sin(t) * math.sin(a) * rx, y, c[2] + math.cos(t) * math.sin(a) * rz]
                if fn:
                    p = fn(p, t, j)
                pts.append(p)
            rings.append(pts)
        self.loft(rings, (c[0], c[1] - ry, c[2]), (c[0], c[1] + ry, c[2]))

    def tube(self, path, radii, n=6, caps=True):
        """A tube along a path of points, round in section, capped at both ends."""
        rings = []
        for i, p in enumerate(path):
            a = path[max(0, i - 1)]
            b = path[min(len(path) - 1, i + 1)]
            t = norm(sub(b, a))
            ref = (0, 0, 1) if abs(t[2]) < 0.9 else (1, 0, 0)
            z = norm(sub(ref, scale(t, dot(ref, t))))
            x = cross(t, z)
            r = radii[i]
            rings.append([add(p, add(scale(x, math.sin(k / n * TAU) * r), scale(z, math.cos(k / n * TAU) * r))) for k in range(n)])
        self.loft(rings, path[0] if caps else None, path[-1] if caps else None)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    length = math.sqrt(dot(a, a)) or 1.0
    return scale(a, 1 / length)


def lerp3(a, b, t):
    return (mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t))


# ---------------------------------------------------------------- the figure

HEAD_C = (0.0, 1.535, 0.03)
HEAD_R = (0.118, 0.13, 0.118)
SASH_V = 0.55
ROBE_ROWS = [0, 0.035, 0.1, 0.2, 0.32, 0.43, 0.52, 0.58, 0.68, 0.78, 0.86, 0.92, 0.965, 1.0]


def head_front(y):
    """z of the front of the head at height y (the face)."""
    t = (y - HEAD_C[1]) / HEAD_R[1]
    return HEAD_C[2] + HEAD_R[2] * math.sqrt(max(0.0, 1 - t * t))


FACE_CUT = 0.11  # hoods stop at this plane in front of the head, so the face shows as a clean disc


def hood_ring(y, rx, rz, cz, n=12, drop=0.0, fold=0.0, cut=True):
    """One ring of a hood or headcloth: an ellipse round (0, y, cz), its back dropping by `drop`
    (cloth falling down the back), a soft fold pressed into the back, its front opened at FACE_CUT."""
    pts = []
    for k in range(n):
        t = k / n * TAU
        back = max(0.0, -math.cos(t))
        dent = 1 - fold * math.exp(-(((t - math.pi) / 0.42) ** 2))
        x = math.sin(t) * rx * dent
        z = cz + math.cos(t) * rz * dent
        if cut and z > FACE_CUT:
            x *= 1 + 0.6 * (z - FACE_CUT) / rz  # the opening's edge rolls outward a little
            z = FACE_CUT
        pts.append((x, y - drop * smoothstep(0.0, 0.75, back), z))
    return pts


def build():
    b = Builder()

    # robe: shared by every silhouette, robe-relative (x/z are multipliers of the shader's radius)
    b.pid, b.mat, b.who, b.shade = 0, 0, -1, 1.0
    rows = []
    for v in ROBE_ROWS:
        pts = []
        for k in range(N_ROBE):
            a = k / N_ROBE * TAU
            mx, mz = robe_mul(a, v)
            pts.append((math.sin(a) * mx, 1.42 * v, math.cos(a) * mz))
        rows.append(b.ring(pts, v))
    for r0, r1 in zip(rows, rows[1:]):
        b.band(r0, r1, N_ROBE)
    b.shade = 0.6
    b.fan(rows[0], b.vert((0, 0.05, 0), 0.04), True, N_ROBE)
    b.shade = 1.0

    # a sash on the wide robe and the straight robe: a dark rolled band and a short hanging end
    for s in (0, 3):
        b.who, b.shade = s, 0.62
        ids = []
        for v, out in ((SASH_V - 0.032, 1.012), (SASH_V, 1.055), (SASH_V + 0.032, 1.012)):
            pts = []
            for k in range(N_ROBE):
                a = k / N_ROBE * TAU
                mx, mz = robe_mul(a, v)
                pts.append((math.sin(a) * mx * out, 1.42 * v, math.cos(a) * mz * out))
            ids.append(b.ring(pts, v))
        b.band(ids[0], ids[1], N_ROBE)
        b.band(ids[1], ids[2], N_ROBE)
        # the knotted end, hanging at the front left
        end = []
        for v, out, a0, a1 in ((SASH_V - 0.03, 1.06, 0.3, 0.66), (SASH_V - 0.1, 1.05, 0.33, 0.66), (SASH_V - 0.17, 1.045, 0.38, 0.68)):
            pts = []
            for a in (a0, (a0 + a1) / 2, a1):
                mx, mz = robe_mul(a, v)
                pts.append((math.sin(a) * mx * out, 1.42 * v, math.cos(a) * mz * out))
            end.append(b.ring(pts, v))
        # rows run top to bottom here, so the strips are wound the other way
        b.strip(end[1], end[0], 3)
        b.strip(end[2], end[1], 3)
    b.shade = 1.0

    # arms in sleeves, mitten hands (white like the face), placed per silhouette on its own robe
    for s in range(SHAPES):
        b.who = s
        for side in (1, -1):
            if s == 2 and side < 0:
                # the elder's right hand reaches forward to the cane
                sh = robe_point(-math.pi / 2, 0.86, 2, -0.035)
                wrist = (-0.27, 0.985, 0.2)
                hand = (-0.3, 0.965, 0.235)
                mid = (lerp3(sh, wrist, 0.5)[0] - 0.02, lerp3(sh, wrist, 0.5)[1] - 0.04, lerp3(sh, wrist, 0.5)[2])
                path = [sh, mid, wrist]
            else:
                hy = {0: 0.86, 1: 0.88, 2: 0.83, 3: 0.86}[s]
                vh = robe_v(hy, s)
                a = side * (math.pi / 2 - 0.22)
                wrist = robe_point(a, vh, s, 0.032)
                wrist = (wrist[0], wrist[1] + 0.02, wrist[2] + 0.015)
                sh = robe_point(side * math.pi / 2, 0.87, s, -0.03)
                mid = lerp3(sh, wrist, 0.5)
                vm = robe_v(mid[1], s)
                surf = robe_point(side * (math.pi / 2 - 0.1), vm, s, 0.04)
                mid = (side * max(abs(mid[0]), abs(surf[0])), mid[1], mid[2] + 0.01)
                path = [sh, mid, wrist]
                d = norm(sub(wrist, mid))
                hand = add(wrist, scale(d, 0.045))
            b.pid, b.mat, b.shade = 0, 0, 0.92
            b.tube(path, [0.04, 0.046, 0.054], 6)
            b.mat, b.shade = 1, 1.0
            b.ball(hand, 0.034, 0.046, 0.036, 6, 3)
    b.mat, b.shade = 0, 1.0

    # head: a rounder white head on a neck; hoods sit behind it, so the face shows as a clean disc
    b.pid, b.mat, b.who = 1, 1, -1
    b.ball(HEAD_C, *HEAD_R, 12, 6)
    b.shade = 0.85
    b.loft([[(math.sin(k / 8 * TAU) * 0.055, y, math.cos(k / 8 * TAU) * 0.05) for k in range(8)] for y in (1.36, 1.45)])
    b.shade = 1.0
    b.mat = 0

    # 0: a draped headcloth falling over the shoulders and down the back, held by a dark cord
    b.who = 0
    rings = [
        hood_ring(1.35, 0.2, 0.18, -0.035, drop=0.17),
        hood_ring(1.42, 0.16, 0.16, -0.035, drop=0.08),
        hood_ring(1.5, 0.158, 0.163, -0.035, drop=0.02),
        hood_ring(1.58, 0.156, 0.162, -0.035),
        hood_ring(1.64, 0.143, 0.15, -0.035),
        hood_ring(1.69, 0.106, 0.114, -0.035, cut=False),
    ]
    b.loft(rings, (0, 1.3, -0.08), (0, 1.712, -0.035))
    b.mat = 2
    b.loft([hood_ring(1.627, 0.149, 0.159, -0.035), hood_ring(1.643, 0.158, 0.168, -0.035), hood_ring(1.659, 0.141, 0.151, -0.035)])
    b.mat = 0

    # 1: the tall pointed hood, a soft fold down its back, the tip bent back
    b.who = 1
    rings = [
        hood_ring(1.33, 0.2, 0.17, -0.035, drop=0.05),
        hood_ring(1.41, 0.155, 0.152, -0.04),
        hood_ring(1.52, 0.156, 0.163, -0.045),
        hood_ring(1.62, 0.146, 0.156, -0.05, fold=0.06),
        hood_ring(1.73, 0.118, 0.13, -0.068, fold=0.12, cut=False),
        hood_ring(1.85, 0.08, 0.09, -0.098, fold=0.16, cut=False),
        hood_ring(1.96, 0.044, 0.052, -0.135, fold=0.12, cut=False),
    ]
    b.loft(rings, (0, 1.3, -0.06), (0, 2.07, -0.19))

    # 2: the elder's soft cowl, resting on the bent back, its peak hanging behind
    b.who = 2
    rings = [
        hood_ring(1.34, 0.205, 0.19, -0.04, drop=0.1),
        hood_ring(1.41, 0.158, 0.16, -0.04, drop=0.03),
        hood_ring(1.5, 0.16, 0.165, -0.045),
        hood_ring(1.59, 0.152, 0.158, -0.05, fold=0.05),
        hood_ring(1.655, 0.118, 0.13, -0.062, fold=0.08, cut=False),
        hood_ring(1.7, 0.06, 0.07, -0.095, cut=False),
    ]
    b.loft(rings, (0, 1.28, -0.08), (0, 1.71, -0.15))

    # 3: a cloth under a tall wound turban, and the single dark eye
    b.who = 3
    rings = [
        hood_ring(1.35, 0.195, 0.175, -0.035, drop=0.08),
        hood_ring(1.42, 0.155, 0.152, -0.035),
        hood_ring(1.52, 0.152, 0.157, -0.035),
        hood_ring(1.6, 0.14, 0.15, -0.035),
    ]
    b.loft(rings, (0, 1.3, -0.07), (0, 1.63, -0.035))
    wraps = [
        (1.585, 0.126, 0.0),
        (1.615, 0.146, 0.026),
        (1.65, 0.132, 0.0),
        (1.695, 0.154, -0.03),
        (1.74, 0.138, 0.0),
        (1.785, 0.16, 0.03),
        (1.83, 0.144, 0.0),
        (1.875, 0.164, -0.03),
        (1.92, 0.148, 0.0),
        (1.96, 0.163, 0.022),
        (1.995, 0.15, 0.0),
        (2.012, 0.105, 0.0),
    ]
    tr = []
    for j, (y, r, tilt) in enumerate(wraps):
        pts = []
        for k in range(12):
            t = k / 12 * TAU
            # each wrap runs diagonally round the head, crossing the one below at the front
            yy = y + tilt * math.cos(t - 0.6 * j)
            pts.append((math.sin(t) * r, yy, -0.03 + math.cos(t) * r * 0.94))
        tr.append(pts)
    b.loft(tr, None, (0, 2.016, -0.03))
    b.mat = 2
    ez = head_front(1.53) + 0.003
    c = b.vert((0, 1.53, ez))
    ring = b.ring([(math.sin(k / 6 * TAU) * 0.029, 1.53 + math.cos(k / 6 * TAU) * 0.029, ez - 0.002) for k in range(6)])
    for k in range(6):
        b.tri.append((c, ring + (k + 1) % 6, ring + k))
    b.mat = 0

    # legs: tapering, mostly hidden inside the robe, with small dark shoes
    b.who = -1
    for pid, sx in ((2, 0.07), (3, -0.07)):
        b.pid, b.mat, b.shade = pid, 0, 0.8
        b.tube([(sx, 0.05, 0.0), (sx, 0.22, 0.0), (sx, 0.52, -0.005)], [0.024, 0.027, 0.032], 6)
        b.mat, b.shade = 2, 1.0
        b.ball((sx, 0.032, 0.03), 0.036, 0.034, 0.068, 6, 3, fn=lambda p, t, j: [p[0], max(p[1], 0.0), p[2]])
    b.mat = 0

    # the elder's cane, a crook at the top
    b.who, b.pid, b.shade = 2, 4, 0.75
    b.tube([(-0.3, 0.0, 0.24), (-0.3, 0.5, 0.24), (-0.3, 0.93, 0.24), (-0.3, 0.975, 0.215), (-0.3, 0.965, 0.18)], [0.012, 0.014, 0.015, 0.015, 0.014], 6)
    return b


# ---------------------------------------------------------------- Blender side


def to_blender(p):
    """Game (x, y up, z forward) to Blender (x, y, z up); the exporter's +Y-up undoes it."""
    return (p[0], -p[2], p[1])


def make_mesh(name, pos, tris):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in pos], [], tris)
    me.validate(clean_customdata=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export(b):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ob = make_mesh("townsfolk", b.pos, b.tri)
    me = ob.data
    ap = me.attributes.new("_apart", "FLOAT2", "POINT")
    ak = me.attributes.new("_akind", "FLOAT_VECTOR", "POINT")
    ap.data.foreach_set("vector", [c for t in b.part for c in t])
    ak.data.foreach_set("vector", [c for t in b.kind for c in t])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_attributes=True,
        export_normals=False,
        export_texcoords=False,
        export_materials="NONE",
        export_yup=True,
        export_apply=True,
    )


def counts(b):
    """Triangles one person of each silhouette draws."""
    out = {}
    for s in range(SHAPES):
        def mine(i):
            w = b.kind[i][1]
            return w == -1 or (w == -2 and s != 1) or w == s
        out[s] = sum(1 for t in b.tri if all(mine(i) for i in t))
    return out


# ---------------------------------------------------------------- previews

CLOTH = {
    0: ((0.66, 0.36, 0.24), (0.42, 0.22, 0.15)),
    1: ((0.32, 0.42, 0.58), (0.2, 0.27, 0.4)),
    2: ((0.7, 0.55, 0.3), (0.5, 0.38, 0.2)),
    3: ((0.36, 0.5, 0.36), (0.24, 0.34, 0.25)),
}


def posed(b, s):
    """The rest pose the shader gives silhouette s: robe shaped, the elder's head lowered."""
    pos = []
    col = []
    top, hem = CLOTH[s]
    for i, p in enumerate(b.pos):
        mat, who, v = b.kind[i]
        pid, shade = b.part[i]
        if v >= 0:
            r, y, oz = robe(v, s)
            p = (p[0] * r, y, p[2] * r * 0.86 + oz)
        if pid == 1 and s == 2:
            p = (p[0], p[1] - 0.2, p[2] + 0.14)
        pos.append(p)
        if mat == 2:
            c = (0.2, 0.17, 0.16)
        elif mat == 1:
            c = (0.95, 0.93, 0.88)
        else:
            t = smoothstep(0.15, 0.85, 1.0 if v < 0 else v)
            c = tuple(mix(hem[k], top[k], t) * shade for k in range(3))
        col.append(c)
    keep = [t for t in b.tri if all(b.kind[i][1] == -1 or (b.kind[i][1] == -2 and s != 1) or b.kind[i][1] == s for i in t)]
    return pos, col, keep


def preview(b, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1500, 900
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.78, 0.64, 0.46, 1)
    bg.inputs[1].default_value = 0.35
    sc.world = world

    mat = bpy.data.materials.new("cloth")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.use_backface_culling = True  # as the game draws them: a face wound the wrong way vanishes
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])

    sand = bpy.data.materials.new("sand")
    sand.use_nodes = True
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.78, 0.64, 0.46, 1)
    bpy.ops.mesh.primitive_plane_add(size=40)
    bpy.context.active_object.data.materials.append(sand)
    wall = bpy.data.materials.new("wall")
    wall.use_nodes = True
    wn = wall.node_tree
    em = wn.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (0.78, 0.64, 0.46, 1)
    out = next(n for n in wn.nodes if n.type == "OUTPUT_MATERIAL")
    wn.links.new(em.outputs[0], out.inputs[0])
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 6, 0), rotation=(math.radians(90), 0, 0))
    bpy.context.active_object.data.materials.append(wall)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.5
    sun.rotation_euler = (math.radians(55), 0, math.radians(-62))
    sc.collection.objects.link(sun)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam

    figs = []
    for s in range(SHAPES):
        pos, col, tris = posed(b, s)
        ob = make_mesh(f"s{s}", pos, tris)
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for t in col for c in (*t, 1.0)])
        ob.data.materials.append(mat)
        figs.append(ob)

    def shoot(path, placements, cx, cz, w):
        for ob in figs:
            ob.hide_render = True
        made = []
        for s, x, rot in placements:
            o = figs[s].copy()
            o.hide_render = False
            sc.collection.objects.link(o)
            o.location = (x, 0, 0)
            o.rotation_euler = (0, 0, rot)
            made.append(o)
        cam.data.ortho_scale = w
        cam.location = (cx, -12, cz)
        cam.rotation_euler = (math.radians(90), 0, 0)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        for o in made:
            bpy.data.objects.remove(o)

    names = ["robe_headcloth", "tall_hood", "elder_cowl", "turban"]
    for s in range(SHAPES):
        # front, side (its left), back
        shoot(os.path.join(out_dir, f"{s}_{names[s]}.png"), [(s, -0.85, 0), (s, 0, math.pi / 2), (s, 0.85, math.pi)], 0, 1.05, 3.6)
    shoot(os.path.join(out_dir, "lineup.png"), [(s, (s - 1.5) * 0.75, 0.35) for s in range(SHAPES)], 0, 1.05, 3.8)
    shoot(os.path.join(out_dir, "heads.png"), [(s, (s - 1.5) * 0.5, 0.5) for s in range(SHAPES)], 0, 1.55, 2.0)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    b = build()
    export(b)
    print("TOWNSFOLK", OUT, "verts", len(b.pos), "tris", len(b.tri), "per silhouette", counts(b))
    if "--preview" in argv:
        preview(b, argv[argv.index("--preview") + 1])


main()
