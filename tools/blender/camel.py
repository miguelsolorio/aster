"""The caravan camel of src/city/caravans.ts, modelled: one mesh, exported to public/art/camel.glb.

    blender --background --python tools/blender/camel.py                    # write the .glb
    blender --background --python tools/blender/camel.py -- --preview DIR   # and render it posed

A dromedary in the game's own frame (metres, +Y up, feet at 0, facing +Z, scale 1), turned into
Blender's Z-up frame only when the mesh is made, so the exporter's +Y-up conversion gives back
exactly these numbers. Every vertex carries what caravans.ts's animal vertex shader reads, with
the meanings of its GB builder:

  _arig   (aRig.xy) x: gait phase offset of a leg,  y: kind (0 rigid, 1 leg, 2 neck and head,
                   3 fringe, 4 tail, 5 neck fringe)
  _arigzw (aRig.zw) z: leg: +1 fore / -1 hind; neck and head: bend weight (0 base .. 1 head);
                   fringe and tail: sway weight (0 root .. 1 tip)
                   w: leg: knee weight (0 above the knee .. 1 below it); neck fringe: neck weight
                   (the glTF exporter drops 4-wide attributes, so two pairs)
  _apivot (aPivot) hip / neck base / tail root, in the game's frame (custom attributes are not
                   converted by the exporter)
  _amp    (aMP)    x: material (0 coat, 1 dark coat, 2 light coat, 3 fringe, 4 load A, 5 load B,
                   6 strap, 7 clay, 8 face shadow, 9 trim), y: load part bit (0 always, 1 bundles,
                   2 jars, 4 blanket and roll)

The hips stay at (+-0.27, 2.15, +-0.8) with the knee one metre under them, the neck turns about
(0, 2.46, 1.0) and the back under the saddle is at 2.88 (caravans.ts CAMEL_BACK), so the walk,
the kneel, the grazing and the riding move this mesh exactly as they moved the built one.
"""

import math
import os
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "camel.glb"))

# caravans.ts material ids
COAT, DARK, LIGHT, FRINGE, LOAD_A, LOAD_B, STRAP, CLAY, SHADOW, TRIM = range(10)
HIP_Y = 2.15
NECK_PIVOT = (0.0, 2.46, 1.0)

# ---------------------------------------------------------------- vectors


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(dot(a, a))


def norm(a):
    n = length(a) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def mix(a, b, t):
    return a + (b - a) * t


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def catmull(pts, per):
    """A smooth path through pts, `per` steps per span; returns (points, span parameter t 0..1)."""
    out, ts = [], []
    n = len(pts)
    for i in range(n - 1):
        p0 = pts[max(0, i - 1)]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[min(n - 1, i + 2)]
        for k in range(per):
            t = k / per
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(3)))
            ts.append((i + t) / (n - 1))
    out.append(pts[-1])
    ts.append(1.0)
    return out, ts


def interp(table, t):
    """Linear lookup in [(t, value-or-tuple), ...]."""
    if t <= table[0][0]:
        return table[0][1]
    for (a, x), (b, y) in zip(table, table[1:]):
        if t <= b:
            u = (t - a) / (b - a) if b > a else 0.0
            if isinstance(x, tuple):
                return tuple(mix(x[j], y[j], u) for j in range(len(x)))
            return mix(x, y, u)
    return table[-1][1]


# ---------------------------------------------------------------- mesh building


class Builder:
    """Triangles, each vertex with the shader's attributes. Every primitive is its own piece:
    normals are smoothed within a piece only."""

    def __init__(self):
        self.pos, self.rig, self.piv, self.mat, self.part, self.piece = [], [], [], [], [], []
        self.tris = []
        self.npiece = 0
        self.crease = {}
        self.set(0, 0)

    def set(self, kind, mat, part=0, ph=0.0, pv=(0.0, 0.0, 0.0), z=0.0, w=0.0):
        self.kind, self.m, self.prt, self.ph, self.pv, self.z, self.w = kind, mat, part, ph, tuple(pv), z, w
        return self

    def begin(self, crease=55):
        self.npiece += 1
        self.crease[self.npiece] = math.cos(math.radians(crease))

    def vert(self, p, mat, z=None, w=None):
        self.pos.append(tuple(p))
        self.rig.append((self.ph, self.kind, self.z if z is None else z, self.w if w is None else w))
        self.piv.append(self.pv)
        self.mat.append(mat)
        self.part.append(self.prt)
        self.piece.append(self.npiece)
        return len(self.pos) - 1

    def tri(self, a, b, c):
        pa, pb, pc = self.pos[a], self.pos[b], self.pos[c]
        if length(cross(sub(pb, pa), sub(pc, pa))) < 1e-12:
            return
        self.tris.append((a, b, c))

    def grid(self, rows, closed, matf, zs=None, ws=None, cap0=None, cap1=None, crease=55):
        """Rows of points (each the same count), joined into quads. matf(t, a, centroid) -> mat for
        the quad between rows i, i+1 and columns k, k+1 (t = i / (rows - 2), a = column angle).
        A vertex is made once per material, so colour edges stay crisp. zs / ws: aRig.z / aRig.w
        per row. cap0 / cap1: a pole point closing the first / last row."""
        self.begin(crease)
        nr, n = len(rows), len(rows[0])
        cols = n if closed else n - 1
        cache = {}

        def v(i, k, m):
            k %= n
            key = (i, k, m)
            if key not in cache:
                cache[key] = self.vert(rows[i][k], m, None if zs is None else zs[i], None if ws is None else ws[i])
            return cache[key]

        def mat_of(i, k, ctr):
            if callable(matf):
                return matf(i / max(1, nr - 2) if nr > 2 else 0.0, (k + 0.5) / n * TAU, ctr)
            return self.m if matf is None else matf

        for i in range(nr - 1):
            for k in range(cols):
                k1 = k + 1
                q = [rows[i][k % n], rows[i][k1 % n], rows[i + 1][k1 % n], rows[i + 1][k % n]]
                ctr = mul(add(add(q[0], q[1]), add(q[2], q[3])), 0.25)
                m = mat_of(i, k, ctr)
                a, b, c, d = v(i, k, m), v(i, k1, m), v(i + 1, k1, m), v(i + 1, k, m)
                self.tri(a, d, c)
                self.tri(a, c, b)
        for cap, i, flip in ((cap0, 0, False), (cap1, nr - 1, True)):
            if cap is None:
                continue
            band = 0 if i == 0 else nr - 2
            for k in range(cols):
                ctr = mul(add(rows[i][k % n], rows[i][(k + 1) % n]), 0.5)
                m = mat_of(band, k, ctr)
                pole = self.vert(cap, m, None if zs is None else zs[i], None if ws is None else ws[i])
                a, b = v(i, k, m), v(i, k + 1, m)
                if flip:
                    self.tri(pole, b, a)
                else:
                    self.tri(pole, a, b)

    def tube(self, path, secs, n=8, up=(0, 1, 0), matf=None, zs=None, ws=None, cap0=True, cap1=True, crease=55, rot=0.0, shape=None):
        """A tube along path. secs[i]: r, (rx, ry), (rx, ry_top, ry_bottom) or
        (rx_top, rx_bottom, ry_top, ry_bottom); 'top' is the side the up hint points to.
        shape(i, a) -> extra radial multiplier."""
        rows = []
        prev_up = norm(up)
        m = len(path)
        for i, c in enumerate(path):
            t = norm(sub(path[min(m - 1, i + 1)], path[max(0, i - 1)]))
            y = sub(prev_up, mul(t, dot(prev_up, t)))
            if length(y) < 1e-6:
                y = sub(norm(up), mul(t, dot(norm(up), t)))
            y = norm(y)
            prev_up = y
            x = cross(y, t)
            s = secs[i]
            if not isinstance(s, tuple):
                s = (s, s, s, s)
            elif len(s) == 2:
                s = (s[0], s[0], s[1], s[1])
            elif len(s) == 3:
                s = (s[0], s[0], s[1], s[2])
            rxt, rxb, ryt, ryb = s
            row = []
            for k in range(n):
                a = rot + k / n * TAU
                ca, sa = math.cos(a), math.sin(a)
                rx = mix(rxb, rxt, (1 + ca) / 2)
                ry = ryt if ca > 0 else ryb
                f = shape(i, a) if shape else 1.0
                row.append(add(c, add(mul(x, sa * rx * f), mul(y, ca * ry * f))))
            rows.append(row)
        c0 = path[0] if cap0 is True else cap0 if cap0 else None
        c1 = path[-1] if cap1 is True else cap1 if cap1 else None
        self.grid(rows, True, matf, zs, ws, c0, c1, max(crease, 360 / n + 12))

    def ball(self, c, r, n=6, rows=3, mat=None, crease=80):
        rx, ry, rz = r if isinstance(r, tuple) else (r, r, r)
        path = [(c[0], c[1], c[2] - rz * math.cos(math.pi * (j + 1) / (rows + 1))) for j in range(rows)]
        secs = [(rx * math.sin(math.pi * (j + 1) / (rows + 1)), ry * math.sin(math.pi * (j + 1) / (rows + 1))) for j in range(rows)]
        self.tube(path, secs, n, (0, 1, 0), mat, None, None, (c[0], c[1], c[2] - rz), (c[0], c[1], c[2] + rz), crease)

    def strip(self, rows, matf=None, zs=None, ws=None, crease=40):
        """An open sheet (a cloth, a strap, a tassel): drawn two-sided by the game."""
        self.grid(rows, False, matf, zs, ws, None, None, crease)


# ---------------------------------------------------------------- the trunk and its hump

# (z, back line without the hump, belly line, half-width above / below the widest line)
TRUNK = [
    (-1.34, 2.4, 2.2, 0.1, 0.09),
    (-1.26, 2.5, 2.05, 0.21, 0.18),
    (-1.08, 2.52, 1.96, 0.31, 0.27),
    (-0.82, 2.55, 1.94, 0.34, 0.3),
    (-0.38, 2.55, 1.96, 0.36, 0.31),
    (-0.15, 2.55, 1.93, 0.38, 0.32),
    (0.08, 2.55, 1.89, 0.4, 0.33),
    (0.56, 2.56, 1.8, 0.39, 0.31),
    (0.8, 2.6, 1.77, 0.35, 0.27),
    (1.02, 2.6, 1.82, 0.29, 0.23),
    (1.2, 2.5, 1.93, 0.21, 0.17),
    (1.31, 2.42, 2.04, 0.12, 0.1),
]
HUMP_Z, HUMP_H, HUMP_BACK, HUMP_FRONT, HUMP_P = -0.05, 0.3, 0.8, 0.7, 3.5


def hump(z):
    """How far the hump lifts the spine at z: one hump, peaked just behind the middle."""
    hw = HUMP_BACK if z < HUMP_Z else HUMP_FRONT
    u = (z - HUMP_Z) / hw
    if abs(u) >= 1:
        return 0.0
    return HUMP_H * math.cos(u * math.pi / 2) ** 2


def trunk_sec(z):
    t = [(r[0], r[1:]) for r in TRUNK]
    top, bottom, wt, wb = interp(t, z)
    cy = bottom + 0.55 * (top - bottom)
    return cy, wt, wb, top - cy, cy - bottom


def trunk_at(z, a, off=0.0):
    """A point on the trunk at z and column angle a (0 the spine, pi/2 the right flank), pushed
    `off` out along the section's own normal."""

    def raw(a):
        cy, wt, wb, ryt, ryb = trunk_sec(z)
        ca, sa = math.cos(a), math.sin(a)
        rx = mix(wb, wt, (1 + ca) / 2)
        ry = ryt if ca > 0 else ryb
        h = hump(z) * max(0.0, ca) ** HUMP_P
        return (sa * rx, cy + ca * ry + h)

    x, y = raw(a)
    if off:
        e = 1e-3
        x0, y0 = raw(a - e)
        x1, y1 = raw(a + e)
        tx, ty = x1 - x0, y1 - y0
        ln = math.hypot(tx, ty) or 1.0
        x, y = x - ty / ln * off, y + tx / ln * off
    return (x, y, z)


def trunk(b):
    n = 12
    zs = [r[0] for r in TRUNK]
    rows = [[trunk_at(z, k / n * TAU) for k in range(n)] for z in zs]
    cy0 = trunk_sec(zs[0])[0]
    cy1 = trunk_sec(zs[-1])[0]
    b.set(0, COAT)
    b.grid(rows, True, COAT, None, None, (0.0, cy0 - 0.02, zs[0] - 0.05), (0.0, cy1 + 0.02, zs[-1] + 0.06), 58)
    # the chest pad a couched camel rests on
    b.ball((0.0, 1.81, 0.74), (0.12, 0.075, 0.15), 5, 1, DARK, 70)


# ---------------------------------------------------------------- legs

LEGS = [(0.27, 0.8, 1, 0.12), (-0.27, 0.8, 1, 0.62), (0.27, -0.8, -1, 0.0), (-0.27, -0.8, -1, 0.5)]


def knee_w(y):
    """aRig.w: the lower leg turns about the knee, one metre under the hip (the shader's kr)."""
    k = HIP_Y - 1.0
    return smoothstep(k + 0.13, k - 0.13, y)


def legs(b):
    n = 6
    for hx, hz, front, ph in LEGS:
        b.set(1, COAT, 0, ph, (hx, HIP_Y, hz), front, 0.0)
        s = 1 if hx > 0 else -1
        if front > 0:
            # (y, z offset, x offset, side, front, back)
            rows = [
                (2.08, 0.0, -0.02, 0.13, 0.17, 0.16),
                (1.78, 0.01, 0.0, 0.11, 0.135, 0.15),
                (1.27, 0.0, 0.0, 0.078, 0.088, 0.08),
                (1.15, 0.006, 0.0, 0.092, 0.118, 0.085),
                (1.03, 0.0, 0.0, 0.072, 0.082, 0.07),
                (0.3, 0.01, 0.0, 0.07, 0.075, 0.07),
                (0.17, 0.05, 0.0, 0.08, 0.09, 0.075),
                (0.09, 0.085, 0.0, 0.15, 0.2, 0.13),
                (0.03, 0.09, 0.0, 0.175, 0.225, 0.15),
            ]
        else:
            rows = [
                (2.1, 0.0, -0.03, 0.16, 0.2, 0.22),
                (1.27, -0.065, 0.0, 0.074, 0.075, 0.09),
                (1.15, -0.075, 0.0, 0.08, 0.075, 0.115),
                (1.03, -0.07, 0.0, 0.068, 0.072, 0.075),
                (0.3, -0.02, 0.0, 0.066, 0.07, 0.066),
                (0.17, 0.02, 0.0, 0.074, 0.082, 0.07),
                (0.09, 0.055, 0.0, 0.135, 0.18, 0.12),
                (0.03, 0.06, 0.0, 0.155, 0.2, 0.135),
            ]
        path = [(hx + s * r[2], r[0], hz + r[1]) for r in rows]
        secs = [(r[3], r[4], r[5]) for r in rows]
        ws = [knee_w(r[0]) for r in rows]
        nb = len(rows) - 1

        def lm(t, a, c, front=front):
            if c[1] < 0.07:
                return DARK  # the leathery rim of the sole
            if front > 0 and 0.96 < c[1] < 1.25 and math.cos(a) > 0.1:
                return DARK  # the calloused knee
            return COAT

        def toes(i, a, nb=nb):
            # two broad toes: the foot is split down the front
            if i < nb - 1:
                return 1.0
            d = math.atan2(math.sin(a), math.cos(a))
            return 1.0 - 0.22 * math.exp(-((d / 0.42) ** 2))

        foot = path[-1]
        b.tube(path, secs, n, (0, 0, 1), lm, None, ws, True, (foot[0], 0.0, foot[2]), 58, 0.0, toes)
        # toenails, one on each toe
        fz = foot[2] + (0.2 if front > 0 else 0.18)
        b.set(1, SHADOW, 0, ph, (hx, HIP_Y, hz), front, 1.0)
        b.begin(30)
        for t in (-1, 1):
            x = foot[0] + t * 0.085
            p0 = b.vert((x - 0.04, 0.06, fz - 0.03), SHADOW)
            p1 = b.vert((x + 0.04, 0.06, fz - 0.03), SHADOW)
            p2 = b.vert((x, 0.1, fz - 0.06), SHADOW)
            p3 = b.vert((x, 0.025, fz + 0.012), SHADOW)
            b.tri(p0, p1, p2)
            b.tri(p0, p3, p1)


# ---------------------------------------------------------------- neck and head


def neck_w(p):
    """aRig.z along the neck: nothing at its root in the chest, all of it at the head."""
    return smoothstep(0.95, 2.2, p[2]) * 0.9 + 0.1 * smoothstep(2.0, 2.2, p[2])


def neck(b):
    pts = [(0, 2.36, 0.86), (0, 2.33, 1.22), (0, 2.25, 1.56), (0, 2.33, 1.86), (0, 2.58, 2.07), (0, 2.84, 2.18)]
    secs = [(0.24, 0.3, 0.33), (0.19, 0.2, 0.23), (0.145, 0.15, 0.17), (0.125, 0.13, 0.15), (0.115, 0.12, 0.14), (0.11, 0.12, 0.12)]
    path, s2 = pts, secs
    zs = [neck_w(p) for p in path]
    b.set(2, COAT, 0, 0.0, NECK_PIVOT, 0.0)
    b.tube(path, s2, 7, (0, 1, 0), COAT, zs, None, True, False, 60)
    # the throat's fringe of longer hair, swinging a little: a ragged hem under the dip
    under = [(p[2], (p[1] - sc[2] * 0.9,)) for p, sc in zip(path, s2)]
    tops = [(0.0, interp(under, z)[0], z) for z in [mix(1.22, 2.0, i / 8) for i in range(9)]]
    b.set(5, FRINGE, 0, 0.0, NECK_PIVOT)
    hem(b, tops, [0.06 if i % 2 == 0 else 0.24 for i in range(9)], (0.0, -1.0, 0.25), [neck_w(t) for t in tops])


def hem(b, tops, lens, down, ws=None):
    """A fringe: a strip hanging from `tops`, its lower edge ragged by `lens` (sway 0 at the top,
    1 at the tips)."""
    d = norm(down)
    bottoms = [add(t, mul(d, ln)) for t, ln in zip(tops, lens)]
    b.begin(40)
    top = [b.vert(t, b.m, 0.0, None if ws is None else ws[i]) for i, t in enumerate(tops)]
    bot = [b.vert(p, b.m, 1.0, None if ws is None else ws[i]) for i, p in enumerate(bottoms)]
    for i in range(len(tops) - 1):
        b.tri(top[i], bot[i], bot[i + 1])
        b.tri(top[i], bot[i + 1], top[i + 1])


def head(b):
    b.set(2, COAT, 0, 0.0, NECK_PIVOT, 1.0)
    # back of the skull to the muzzle, a little nose-down
    pts = [(0, 2.94, 2.1), (0, 2.93, 2.2), (0, 2.9, 2.35), (0, 2.83, 2.55), (0, 2.77, 2.75), (0, 2.75, 2.85)]
    # (rx_top, rx_bottom, ry_top, ry_bottom)
    secs = [
        (0.08, 0.08, 0.075, 0.085),
        (0.135, 0.145, 0.13, 0.165),
        (0.135, 0.14, 0.125, 0.155),
        (0.095, 0.105, 0.1, 0.115),
        (0.09, 0.105, 0.085, 0.11),
        (0.065, 0.08, 0.06, 0.075),
    ]

    def hm(t, a, c):
        if c[2] > 2.66:
            return LIGHT  # the paler muzzle
        if c[2] < 2.4 and math.cos(a) < -0.55:
            return LIGHT  # the jaw's underside
        return COAT

    b.tube(pts, secs, 8, (0, 1, 0), hm, None, None, True, True, 55)
    # the split upper lip: two soft lobes hanging over the lower lip
    for s in (-1, 1):
        b.ball((s * 0.04, 2.725, 2.835), (0.045, 0.055, 0.055), 4, 2, LIGHT, 75)
    b.ball((0.0, 2.655, 2.77), (0.055, 0.035, 0.07), 4, 2, LIGHT, 75)  # the drooping lower lip
    b.set(2, SHADOW, 0, 0.0, NECK_PIVOT, 1.0)
    b.begin(40)
    for s in (-1, 1):
        # nostril slits, high on the muzzle
        a = b.vert((s * 0.032, 2.808, 2.845), SHADOW)
        c = b.vert((s * 0.07, 2.79, 2.8), SHADOW)
        d = b.vert((s * 0.056, 2.818, 2.815), SHADOW)
        b.tri(a, c, d)
    for s in (-1, 1):
        # the eye, and a heavy lid hooded over it
        b.set(2, SHADOW, 0, 0.0, NECK_PIVOT, 1.0)
        b.ball((s * 0.124, 2.945, 2.35), (0.022, 0.026, 0.034), 4, 1, SHADOW, 80)
        b.set(2, COAT, 0, 0.0, NECK_PIVOT, 1.0)
        b.begin(70)
        l0 = b.vert((s * 0.105, 2.99, 2.29), COAT)
        l1 = b.vert((s * 0.165, 2.958, 2.355), COAT)
        l2 = b.vert((s * 0.105, 2.985, 2.41), COAT)
        l3 = b.vert((s * 0.1, 3.03, 2.35), COAT)
        b.tri(l0, l1, l3)
        b.tri(l3, l1, l2)
        # small rounded ears, laid back
        base = (s * 0.085, 3.0, 2.16)
        b.tube([base, (s * 0.105, 3.05, 2.12)], [(0.034, 0.013, 0.013), (0.026, 0.011, 0.011)], 4, (s, 0.3, 0.6), lambda t, a, c: DARK if math.cos(a) > 0.3 else COAT, None, None, True, True, 70)
    # a tuft on the poll
    b.set(2, FRINGE, 0, 0.0, NECK_PIVOT, 1.0)
    b.tube([(0, 2.98, 2.13), (0, 3.04, 2.18), (0, 3.03, 2.25)], [0.05, 0.04, 0.012], 3, (0, 1, 0), FRINGE, None, None, True, True, 70)


# ---------------------------------------------------------------- tail


def tail(b):
    root = (0.0, 2.5, -1.3)
    b.set(4, COAT, 0, 0.0, root)
    pts = [root, (0, 2.3, -1.42), (0, 1.98, -1.445)]
    ts = [0.0, 0.5, 1.0]
    secs = [mix(0.055, 0.03, t) for t in ts]
    b.tube(pts, secs, 4, (0, 0, -1), COAT, [0.1 + 0.8 * t for t in ts], None, False, True, 70)
    # the tassel
    b.set(4, DARK, 0, 0.0, root)
    tp = [(0, 2.06, -1.445), (0, 1.9, -1.45), (0, 1.74, -1.43)]
    b.tube(tp, [(0.035, 0.03), (0.06, 0.045), (0.015, 0.015)], 4, (0, 0, -1), DARK, [0.85, 0.94, 1.0], None, True, True, 70)


# ---------------------------------------------------------------- saddle pad and fringes


def draped(b, z0, z1, a0, a1, nz, fr, off, matf, fold=0.0, folds=4.0):
    """A cloth laid on the trunk from z0 to z1 and from column angle a0 to a1 (0 the spine) at the
    fractions `fr`, held `off` off it; fold ripples where it hangs down the flanks."""
    rows = []
    for f in fr:
        a = mix(a0, a1, f)
        hang = smoothstep(0.7, 1.6, abs(a))
        row = []
        for i in range(nz + 1):
            u = i / nz
            z = mix(z0, z1, u)
            o = off + fold * hang * (0.5 + 0.5 * math.cos(u * folds * TAU))
            row.append(trunk_at(z, a, o))
        rows.append(row)
    b.strip(rows, matf, None, None, 50)
    return rows


def saddle(b):
    """The felt pad on the hump every camel wears, tassels hanging from its hem."""
    b.set(0, TRIM)
    edge = 1.62

    def pm(t, a, c):
        return LOAD_A if t < 0.01 or t > 0.99 else TRIM

    draped(b, -0.52, 0.44, -edge, edge, 4, [0, 0.07, 0.3, 0.5, 0.7, 0.93, 1], 0.045, pm, 0.012, 2.0)
    b.set(3, FRINGE)
    for s in (-1, 1):
        zs = [mix(-0.5, 0.42, i / 12) for i in range(13)]
        tops = [trunk_at(z, s * edge, 0.03) for z in zs]
        hem(b, tops, [0.42 if i % 2 == 1 else 0.1 for i in range(13)], (s * 0.12, -1.0, 0.0))


# ---------------------------------------------------------------- loads


def strap(b, part, z, off, width=0.07):
    """A strap over the back at z, from flank to flank."""
    b.set(0, STRAP, part)
    rows = []
    for j in range(9):
        a = mix(-1.75, 1.75, j / 8)
        rows.append([trunk_at(z - width, a, off), trunk_at(z + width, a, off)])
    b.strip(rows, STRAP, None, None, 50)


def ring(b, c, axis, r, w):
    """A rope binding: a short open band round an axis ('x' or 'y' or 'z')."""
    if axis == "z":
        path = [add(c, (0, 0, -w)), add(c, (0, 0, w))]
        up = (0, 1, 0)
    elif axis == "x":
        path = [add(c, (-w, 0, 0)), add(c, (w, 0, 0))]
        up = (0, 1, 0)
    else:
        path = [add(c, (0, -w, 0)), add(c, (0, w, 0))]
        up = (0, 0, 1)
    sec = r if isinstance(r, tuple) else (r, r)
    b.tube(path, [sec, sec], 6, up, STRAP, None, None, False, False, 70)


def bundles(b):
    """Load 1: a lashed bundle either side and the strap that carries them."""
    for s in (-1, 1):
        cx, cy = s * 0.63, 2.52
        b.set(0, LOAD_A, 1)
        zs = [-0.47, -0.32, 0.0, 0.32, 0.47]
        sc = [0.6, 0.97, 0.92, 0.97, 0.6]
        path = [(cx, cy + 0.01 * math.sin(z * 9), z + 0.04) for z in zs]
        secs = [(0.2 * f, 0.3 * f, 0.3 * f) for f in sc]

        def lump(i, a):
            return 1.0 + 0.05 * math.cos(3 * a + i)

        b.tube(path, secs, 6, (0, 1, 0), LOAD_A, None, None, True, True, 45, 0.0, lump)
        b.set(0, STRAP, 1)
        ring(b, (cx, cy, 0.04), "z", (0.195, 0.29), 0.035)
    strap(b, 1, 0.04, 0.11)


def jars(b):
    """Load 2: a water jar either side, in rope cradles."""
    for s in (-1, 1):
        cx, cz = s * 0.64, 0.1
        b.set(0, CLAY, 2)
        prof = [(2.18, 0.09), (2.3, 0.2), (2.48, 0.235), (2.68, 0.17), (2.82, 0.075), (2.92, 0.105)]
        path = [(cx, y, cz) for y, r in prof]
        b.tube(path, [r for y, r in prof], 6, (0, 0, 1), CLAY, None, None, True, False, 55)
        b.set(0, STRAP, 2)
        ring(b, (cx, 2.52, cz), "y", 0.235, 0.03)
    strap(b, 2, 0.1, 0.11)


def blanket(b):
    """Load 4: a folded blanket over the hump and a rolled cloth tied on top."""
    b.set(0, LOAD_B, 4)

    def bm(t, a, c):
        return TRIM if t < 0.01 or t > 0.99 else LOAD_B

    draped(b, -0.8, 0.72, -1.95, 1.95, 6, [0, 0.07, 0.3, 0.5, 0.7, 0.93, 1], 0.1, bm, 0.035, 2.5)
    b.set(0, LOAD_A, 4)
    y, z = 3.06, -0.12
    b.tube([(-0.5, y, z), (0.5, y, z)], [0.15, 0.15], 6, (0, 1, 0), lambda t, a, c: LOAD_B if abs(c[0]) > 0.5 else LOAD_A, None, None, True, True, 50)
    b.set(0, STRAP, 4)
    for x in (-0.28, 0.28):
        ring(b, (x, y, z), "x", 0.155, 0.025)


# ---------------------------------------------------------------- the whole camel


def camel():
    b = Builder()
    trunk(b)
    legs(b)
    neck(b)
    head(b)
    tail(b)
    saddle(b)
    body_tris = len(b.tris)
    bundles(b)
    jars(b)
    blanket(b)
    return b, body_tris


def finish(b):
    """Corner normals smoothed across each piece within its crease angle, then the vertices made
    unique by (position, normal, attributes). A closed piece wound inward is turned round first,
    so every normal points out. Returns pos, nrm, rig, piv, mp, tris."""
    b.pos = [(p[0], max(0.0, p[1]), p[2]) for p in b.pos]
    pieces = {}
    for f, t in enumerate(b.tris):
        pieces.setdefault(b.piece[t[0]], []).append(f)
    for fs in pieces.values():
        ctr = (0.0, 0.0, 0.0)
        for f in fs:
            for v in b.tris[f]:
                ctr = add(ctr, b.pos[v])
        ctr = mul(ctr, 1.0 / (3 * len(fs)))
        vol = sum(dot(sub(b.pos[b.tris[f][0]], ctr), cross(sub(b.pos[b.tris[f][1]], ctr), sub(b.pos[b.tris[f][2]], ctr))) for f in fs)
        if vol < 0:
            for f in fs:
                a, c1, c2 = b.tris[f]
                b.tris[f] = (a, c2, c1)
    fn = [cross(sub(b.pos[c1], b.pos[a]), sub(b.pos[c2], b.pos[a])) for a, c1, c2 in b.tris]
    at = {}

    def key_of(v):
        return (b.piece[v], round(b.pos[v][0], 6), round(b.pos[v][1], 6), round(b.pos[v][2], 6))

    for f, t in enumerate(b.tris):
        for v in t:
            at.setdefault(key_of(v), []).append(f)
    out_pos, out_nrm, out_rig, out_piv, out_mp, out_tris = [], [], [], [], [], []
    index = {}
    for f, t in enumerate(b.tris):
        nf = norm(fn[f])
        tri = []
        for v in t:
            key = key_of(v)
            cos_lim = b.crease[b.piece[v]]
            acc = (0.0, 0.0, 0.0)
            for g in at[key]:
                if dot(nf, norm(fn[g])) >= cos_lim:
                    acc = add(acc, fn[g])
            nv = norm(acc) if length(acc) > 1e-12 else nf
            ukey = (key, round(nv[0], 3), round(nv[1], 3), round(nv[2], 3), b.rig[v], b.piv[v], b.mat[v], b.part[v])
            if ukey not in index:
                index[ukey] = len(out_pos)
                out_pos.append(b.pos[v])
                out_nrm.append(nv)
                out_rig.append(b.rig[v])
                out_piv.append(b.piv[v])
                out_mp.append((float(b.mat[v]), float(b.part[v])))
            tri.append(index[ukey])
        out_tris.append(tuple(tri))
    return out_pos, out_nrm, out_rig, out_piv, out_mp, out_tris


# ---------------------------------------------------------------- Blender side


def to_blender(p):
    """Game (x, y up, z forward) to Blender (x, y, z up); the exporter's +Y-up undoes it."""
    return (p[0], -p[2], p[1])


def make_mesh(name, pos, nrm, tris):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in pos], [], tris)
    me.shade_smooth()
    me.normals_split_custom_set_from_vertices([to_blender(n) for n in nrm])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def set_attr(me, name, kind, values):
    a = me.attributes.new(name, kind, "POINT")
    prop = "value" if kind == "FLOAT" else "vector"
    a.data.foreach_set(prop, [c for t in values for c in t])


def export(model):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    pos, nrm, rig, piv, mp, tris = model
    ob = make_mesh("camel", pos, nrm, tris)
    me = ob.data
    # the exporter drops 4-wide attributes: aRig goes as two pairs, joined again in caravans.ts
    set_attr(me, "_arig", "FLOAT2", [(r[0], r[1]) for r in rig])
    set_attr(me, "_arigzw", "FLOAT2", [(r[2], r[3]) for r in rig])
    set_attr(me, "_apivot", "FLOAT_VECTOR", piv)
    set_attr(me, "_amp", "FLOAT2", mp)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_attributes=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="NONE",
        export_yup=True,
        export_apply=True,
    )


# ---------------------------------------------------------------- previews


def rx(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c)


def posed(model, g=0.0, ph=0.0, sit=0.0, bow=0.0):
    """animalVert's pose of the rest mesh (legs, knees, neck, kneel; not the sways or the roll)."""
    pos, nrm, rig, piv, mp, tris = model
    sit = sit * sit * (3 - 2 * sit)
    out = []
    for p, (o, kind, z, w), pv in zip(pos, rig, piv):
        th = TAU * (ph + o)
        q = p
        if kind == 1:
            front = z
            a1 = 0.46 * g * math.sin(th)
            kn = 0.95 * g * max(0.0, -math.cos(th))
            a1 = mix(a1, -1.2 if front > 0 else 1.0, sit)
            kn = mix(kn, 2.55 if front > 0 else -2.45, sit)
            d = sub(p, pv)
            kr = (0.0, -1.0, 0.0)
            d = add(kr, rx(sub(d, kr), kn * w))
            d = rx(d, a1)
            q = add(pv, d)
        elif kind == 2 or kind == 5:
            wt = z if kind == 2 else w
            pitch = (0.11 * g * math.sin(TAU * ph + 0.8) - 0.5 * sit + bow) * wt
            q = add(pv, rx(sub(p, pv), pitch))
        y = q[1] + 0.04 * g * math.sin(2 * TAU * ph) * smoothstep(0.3, 2.2, p[1]) - 1.5 * sit
        if kind == 1:
            y = max(y, 0.02)
        out.append((q[0], y, q[2]))
    return out


COAT_RGB = (0.62, 0.5, 0.36)
LOAD_RGB = (0.62, 0.28, 0.22)


def colour(m):
    c, ld = COAT_RGB, LOAD_RGB
    return [
        c,
        tuple(x * 0.5 for x in c),
        (c[0] * 1.18, c[1] * 1.1, c[2]),
        (c[0] * 1.22, c[1] * 1.1, c[2] * 0.92),
        ld,
        (ld[2] * 0.8 + 0.06, ld[0] * 0.8 + 0.05, ld[1] * 0.8 + 0.03),
        (0.24, 0.18, 0.13),
        (0.62, 0.38, 0.26),
        (0.07, 0.055, 0.05),
        tuple(x * 0.8 + 0.05 for x in c),
    ][m]


def preview(model, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1000, 700
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.78, 0.66, 0.5, 1)
    bg.inputs[1].default_value = 0.45
    sc.world = world
    mat = bpy.data.materials.new("coat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.95
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    sand = bpy.data.materials.new("sand")
    sand.use_nodes = True
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.74, 0.6, 0.42, 1)
    bpy.ops.mesh.primitive_plane_add(size=60)
    bpy.context.active_object.data.materials.append(sand)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam
    _, nrm, rig, piv, mp, tris = model

    def build(pos, variant=0, x_off=0.0):
        keep = [i for i, t in enumerate(tris) if all(mp[v][1] < 0.5 or (int(variant) // int(mp[v][1])) % 2 == 1 for v in t)]
        ob = make_mesh("camel_p", [add(p, (x_off, 0, 0)) for p in pos], nrm, [tris[i] for i in keep])
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        cols = []
        for (o, kind, z, w), m in zip(rig, mp):
            c = tuple(x ** 2.2 for x in colour(int(m[0])))
            if kind in (3, 5):
                c = tuple(x * (1 - 0.22 * z) for x in c)
            cols.extend((*c, 1.0))
        a.data.foreach_set("color", cols)
        ob.data.materials.append(mat)
        return ob

    def aim(target, eye):
        d = sub(target, eye)
        cam.location = eye
        cam.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[0], -d[1]) + math.pi)

    def shoot(name):
        sc.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    def g(p):
        return to_blender(p)

    shots = [
        ("stand", posed(model), 0),
        ("stride", posed(model, g=1.0, ph=0.25), 0),
        ("kneel", posed(model, sit=1.0), 0),
        ("load5", posed(model), 5),
        ("load6", posed(model), 6),
        ("kneel_load5", posed(model, sit=1.0), 5),
    ]
    for name, pos, variant in shots:
        ob = build(pos, variant)
        cam.data.ortho_scale = 5.2
        aim(g((0, 1.6, 0.6)), g((-12, 1.6, 0.6)))
        shoot(f"camel_{name}_side.png")
        aim(g((0, 1.6, 0.5)), g((-8.5, 5.5, 8.0)))
        shoot(f"camel_{name}_34.png")
        bpy.data.objects.remove(ob)
    # the head close up, and the loads in a row
    ob = build(posed(model), 0)
    cam.data.ortho_scale = 1.4
    aim(g((0, 2.85, 2.4)), g((-6, 3.4, 4.8)))
    shoot("camel_head.png")
    bpy.data.objects.remove(ob)
    obs = [build(posed(model), v, x) for v, x in ((1, -4.5), (2, -1.5), (4, 1.5), (0, 4.5))]
    cam.data.ortho_scale = 11.0
    aim(g((0, 1.6, 0)), g((-6, 6, 9)))
    shoot("camel_loads.png")
    for o in obs:
        bpy.data.objects.remove(o)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    b, body_tris = camel()
    model = finish(b)
    export(model)
    parts = {}
    for t in model[5]:
        p = int(model[4][t[0]][1])
        parts[p] = parts.get(p, 0) + 1
    print("CAMEL verts", len(model[0]), "tris", len(model[5]), "body", body_tris, "by part", parts)
    print("CAMEL file", OUT, os.path.getsize(OUT))
    if "--preview" in argv:
        preview(model, argv[argv.index("--preview") + 1])


main()
