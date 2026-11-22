"""The desert animals of src/world/fauna.ts, modelled: one mesh per species, exported to
public/art/fauna.glb.

    blender --background --python tools/blender/fauna.py                    # write the .glb
    blender --background --python tools/blender/fauna.py -- --preview DIR   # and render each animal

Everything is built in the game's own frame (metres, +Y up, feet at 0, facing +Z, scale 1) and
turned into Blender's Z-up frame only when the mesh is made, so the exporter's +Y-up conversion
gives back exactly these numbers. Every vertex carries what the fauna vertex shader reads, with
the meanings of fauna.ts (GB):

  _arig   (aRig.xy) x: gait phase offset of a leg,  y: kind (0 rigid, 1 leg, 2 head and neck,
                   3 tail, 4 ear, 5 wing)
  _arigzw (aRig.zw) z: weight (head 1; along a tail 0 root .. 1 tip; wing side +-1),
                   w: ear side +-1   (the glTF exporter drops 4-wide attributes, so two pairs)
  _apivot (aPivot) the joint the part turns about (hip, neck base, tail root, shoulder), in the
                   game's frame (custom attributes are not converted by the exporter)
  _amat   (aMP.x)  material (0 coat, 1 dark coat, 2 pale, 3 horn and hoof, 4 eye and nose,
                   5 inner ear); aMP.y, the species, is the mesh's name (fauna.ts fills it in)

Pivots, phases and weights are the procedural ones, so every gait, the grazing, the flight and
the riding move these meshes exactly as they moved the built ones. Normals are smoothed within
each part up to a crease angle, so the forms take the sun in soft facets.
"""

import math
import os
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "fauna.glb"))

ORYX, FOX, HARE, LIZARD, VULTURE, GAZELLE, ASS, GOAT, TORTOISE, SNAKE, GROUSE = range(11)
NAMES = ["oryx", "fox", "hare", "lizard", "vulture", "gazelle", "ass", "goat", "tortoise", "snake", "grouse"]
# fauna.ts SPEC coats, for the previews only
COAT = [
    (0.86, 0.8, 0.7),
    (0.88, 0.74, 0.54),
    (0.6, 0.5, 0.38),
    (0.66, 0.55, 0.4),
    (0.3, 0.24, 0.2),
    (0.8, 0.6, 0.4),
    (0.66, 0.6, 0.53),
    (0.4, 0.3, 0.22),
    (0.55, 0.46, 0.32),
    (0.82, 0.72, 0.55),
    (0.76, 0.62, 0.42),
]
COAT[GOAT] = (0.55, 0.42, 0.3)  # a mid goat coat (the game picks one of several)

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


def lerp3(a, b, t):
    return (mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t))


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
    """Triangles for one species, each vertex with the shader's attributes. Every primitive is
    its own piece: normals are smoothed within a piece only."""

    def __init__(self, sp):
        self.sp = sp
        self.pos, self.rig, self.piv, self.mat, self.piece = [], [], [], [], []
        self.tris = []
        self.npiece = 0
        self.crease = {}
        self.set(0, 0)

    def set(self, kind, mat, ph=0.0, pv=(0.0, 0.0, 0.0), z=0.0, w=0.0):
        self.kind, self.m, self.ph, self.pv, self.z, self.w = kind, mat, ph, tuple(pv), z, w
        return self

    def begin(self, crease=55):
        self.npiece += 1
        self.crease[self.npiece] = math.cos(math.radians(crease))

    def vert(self, p, mat, z=None):
        self.pos.append(tuple(p))
        self.rig.append((self.ph, self.kind, self.z if z is None else z, self.w))
        self.piv.append(self.pv)
        self.mat.append(mat)
        self.piece.append(self.npiece)
        return len(self.pos) - 1

    def tri(self, a, b, c):
        pa, pb, pc = self.pos[a], self.pos[b], self.pos[c]
        if length(cross(sub(pb, pa), sub(pc, pa))) < 1e-12:
            return
        self.tris.append((a, b, c))

    def grid(self, rows, closed, matf, zs=None, cap0=None, cap1=None, crease=55):
        """Rows of points (each the same count), joined into quads. matf(t, a, centroid) -> mat for
        the quad between rows i, i+1 and columns k, k+1 (t = i / (rows - 1), a = column angle).
        A vertex is made once per material, so colour edges stay crisp. cap0 / cap1: a pole point
        closing the first / last row (with the material of the band next to it)."""
        self.begin(crease)
        nr, n = len(rows), len(rows[0])
        cols = n if closed else n - 1
        cache = {}

        def v(i, k, m):
            k %= n
            key = (i, k, m)
            if key not in cache:
                cache[key] = self.vert(rows[i][k], m, None if zs is None else zs[i])
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
                # outward when rows run along the path and columns turn from +up toward +side
                self.tri(a, d, c)
                self.tri(a, c, b)
        for cap, i, flip in ((cap0, 0, False), (cap1, nr - 1, True)):
            if cap is None:
                continue
            band = 0 if i == 0 else nr - 2
            for k in range(cols):
                ctr = mul(add(rows[i][k % n], rows[i][(k + 1) % n]), 0.5)
                m = mat_of(band, k, ctr) if not isinstance(cap, tuple) or len(cap) != 2 else cap[1]
                pole_p = cap if len(cap) == 3 else cap[0]
                pole = self.vert(pole_p, m, None if zs is None else zs[i])
                a, b = v(i, k, m), v(i, k + 1, m)
                if flip:
                    self.tri(pole, b, a)
                else:
                    self.tri(pole, a, b)

    def tube(self, path, secs, n=8, up=(0, 1, 0), matf=None, zs=None, cap0=True, cap1=True, crease=55, rot=0.0, shape=None):
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
        # never a crease between the sides of a thin tube: it reads round, its outline faceted
        self.grid(rows, True, matf, zs, c0, c1, max(crease, 360 / n + 12))

    def ball(self, c, r, n=6, rows=3, mat=None):
        rx, ry, rz = r if isinstance(r, tuple) else (r, r, r)
        path = [(c[0], c[1], c[2] + rz * math.cos(math.pi * (j + 1) / (rows + 1)) * -1) for j in range(rows)]
        secs = [(rx * math.sin(math.pi * (j + 1) / (rows + 1)), ry * math.sin(math.pi * (j + 1) / (rows + 1))) for j in range(rows)]
        self.tube(path, secs, n, (0, 1, 0), mat, None, (c[0], c[1], c[2] - rz), (c[0], c[1], c[2] + rz), 80)

    def sheet(self, rows, matf=None, zs=None, crease=40):
        self.grid(rows, False, matf, zs, None, None, crease)


# ---------------------------------------------------------------- shared anatomy


def prof(z, top, bottom, wt, wb, k=0.55):
    """A trunk section from its outline: back and belly heights, half-widths above and below the
    widest line (which sits k of the way up)."""
    cy = bottom + k * (top - bottom)
    return (z, cy, wt, wb, top - cy, cy - bottom)


def low_side(a):
    """A trunk column just under the widest line of the flank (n = 12)."""
    d = math.degrees(a) % 360
    return 90 < d < 120 or 240 < d < 270


def belly(a):
    """A trunk column along the belly and the lower flanks (n = 12: the bottom four)."""
    d = math.degrees(a) % 360
    return 120 < d < 240


def crest(path, secs):
    """The line along the crest of neck(path, secs)."""
    t = norm(sub(path[-1], path[0]))
    upv = norm((0.0, t[2], -t[1]))
    return [add(p, mul(upv, s[1] * 0.92)) for p, s in zip(path, secs)]


def body(b, st, n=12, matf=None):
    """A trunk along z: st = [(z, cy, rx_top, rx_bottom, ry_top, ry_bottom), ...], rump first."""
    path = [(0.0, s[1], s[0]) for s in st]
    secs = [tuple(s[2:]) for s in st]
    b.tube(path, secs, n, (0, 1, 0), matf, None, True, True, 60)


def head(b, path, secs, n=9, matf=None, cap1=True):
    b.tube(path, secs, n, (0, 1, 0), matf, None, True, cap1, 60)


def neck(b, path, secs, n=8, matf=None):
    """Up and forward; secs (rx, ry_crest, ry_throat). The up hint is the crest side."""
    t = norm(sub(path[-1], path[0]))
    upv = norm((0.0, t[2], -t[1]))
    b.tube(path, secs, n, upv, matf, None, True, True, 60)


def hoofed_legs(b, sp, hx, hy, front, back, H, r0, r1, m_up, m_low, n=6, thigh=1.0):
    """The four legs of a hoofed animal, pivots at (+-hx, hy, front / back) like fauna.ts hooves(),
    phases 0 / 0.5 / 0.5 / 0. H is the hip height (sets the joints), r0 / r1 the thick and thin
    radii. Fore legs: straight with a knee; hind legs: a thigh, the hock behind, a cannon."""
    for fx, fz, ph in ((hx, front, 0.0), (-hx, front, 0.5), (hx, back, 0.5), (-hx, back, 0.0)):
        b.set(1, m_up, ph, (fx, hy, fz))
        hind = fz < 0
        if not hind:
            pts = [
                (fx, hy + 0.06 * H, fz - 0.02 * H),
                (fx, 0.82 * H, fz - 0.035 * H),
                (fx, 0.64 * H, fz - 0.03 * H),
                (fx, 0.46 * H, fz - 0.012 * H),
                (fx, 0.33 * H, fz),
                (fx, 0.26 * H, fz + 0.002 * H),
                (fx, 0.06 * H, fz + 0.012 * H),
                (fx, 0.035 * H, fz + 0.03 * H),
                (fx, 0.0, fz + 0.045 * H),
            ]
            # (side, front, back)
            secs = [
                (r0 * 1.05, r0 * 1.35, r0 * 1.2),
                (r0 * 0.95, r0 * 1.25, r0 * 1.15),
                (r0 * 0.72, r0 * 0.9, r0 * 0.8),
                (r1 * 1.05, r1 * 1.05, r1 * 1.0),
                (r1 * 1.12, r1 * 1.15, r1 * 1.1),
                (r1 * 0.8, r1 * 0.84, r1 * 0.94),
                (r1 * 0.95, r1 * 1.0, r1 * 1.12),
                (r1 * 0.98, r1 * 1.15, r1 * 0.95),
                (r1 * 1.08, r1 * 1.35, r1 * 1.0),
            ]
            knee = 3
        else:
            pts = [
                (fx, hy + 0.08 * H, fz + 0.02 * H),
                (fx, 0.84 * H, fz + 0.07 * H),
                (fx, 0.68 * H, fz + 0.05 * H),
                (fx, 0.52 * H, fz - 0.06 * H),
                (fx, 0.41 * H, fz - 0.12 * H),
                (fx, 0.33 * H, fz - 0.095 * H),
                (fx, 0.065 * H, fz - 0.035 * H),
                (fx, 0.035 * H, fz - 0.012 * H),
                (fx, 0.0, fz + 0.005 * H),
            ]
            secs = [
                (r0 * 1.15 * thigh, r0 * 1.7 * thigh, r0 * 1.6 * thigh),
                (r0 * 1.05 * thigh, r0 * 1.6 * thigh, r0 * 1.45 * thigh),
                (r0 * 0.72, r0 * 1.05, r0 * 1.2),
                (r1 * 1.05, r1 * 1.2, r1 * 1.5),
                (r1 * 0.95, r1 * 1.0, r1 * 1.45),
                (r1 * 0.8, r1 * 0.86, r1 * 0.93),
                (r1 * 0.95, r1 * 1.0, r1 * 1.12),
                (r1 * 0.98, r1 * 1.15, r1 * 0.95),
                (r1 * 1.08, r1 * 1.35, r1 * 1.0),
            ]
            knee = 4
        nb = len(pts) - 1

        def lm(t, a, c, knee=knee, nb=nb):
            i = round(t * (nb - 1))
            if i >= nb - 1:
                return 3  # the hoof
            return m_up if i < knee else m_low

        b.tube(pts, secs, n, (0, 0, 1), lm, None, True, (pts[-1][0], 0.0, pts[-1][2] + 0.01 * H), 62, math.pi / n)


def horn(b, pts, r0, r1, n=5, per=2, ridges=0.0, nr=6):
    """A tapering curved horn through pts; ridges rings the lower part (an oryx's annulations)."""
    path, ts = catmull(pts, per)
    secs = []
    for t in ts:
        r = mix(r0, r1, t ** 0.9)
        if ridges > 0 and t < 0.6:
            r *= 1 + ridges * (0.5 + 0.5 * math.cos(t * nr * TAU)) * (1 - t / 0.6)
        secs.append(r)
    b.tube(path, secs, n, (0, 0, 1), 3, None, True, True, 70)


def ear(b, pts, widths, thick, inner, outer, n=6, tip_mat=None, tip_from=1.1, face=(0, 0, 1)):
    """A leaf-shaped ear: wide one way, thin the other, its hollow facing `face` in `inner`."""

    def em(t, a, c):
        if tip_mat is not None and t >= tip_from:
            return tip_mat
        return inner if math.cos(a) > 0.2 else outer

    secs = [(w, thick * 0.6, thick) for w in widths]
    b.tube(pts, secs, n, face, em, None, True, True, 70)


def eye(b, c, r, side):
    """A small dark eye pressed into the side of the head, a little proud of it."""
    b.ball((c[0] + side * r * 0.2, c[1], c[2]), (r * 0.7, r, r), 4, 1, 4)


def tail(b, pts, secs, n, matf, crease=60, up=(0, 1, 0)):
    path, ts = catmull(pts, 2)
    secs = [s if isinstance(s, tuple) else (s, s, s) for s in secs]
    s2 = [interp(list(zip([i / (len(secs) - 1) for i in range(len(secs))], secs)), t) for t in ts]
    b.tube(path, s2, n, up, matf, [t for t in ts], True, True, crease)


# ---------------------------------------------------------------- the species


def oryx():
    b = Builder(ORYX)

    def coat(t, a, c):
        if belly(a):
            return 2  # white belly
        if low_side(a) and -0.55 < c[2] < 0.6:
            return 1  # the dark band along the flank
        return 0

    b.set(0, 0)
    body(
        b,
        [
            prof(-0.83, 1.15, 0.99, 0.04, 0.04),
            prof(-0.78, 1.25, 0.86, 0.14, 0.12),
            prof(-0.65, 1.31, 0.78, 0.21, 0.17),
            prof(-0.47, 1.31, 0.8, 0.235, 0.19),
            prof(-0.29, 1.3, 0.86, 0.24, 0.19),
            prof(-0.05, 1.3, 0.78, 0.26, 0.22),
            prof(0.2, 1.32, 0.71, 0.27, 0.21),
            prof(0.4, 1.355, 0.7, 0.24, 0.17),
            prof(0.56, 1.33, 0.76, 0.19, 0.13),
            prof(0.68, 1.27, 0.87, 0.12, 0.1),
            prof(0.75, 1.2, 0.97, 0.04, 0.04),
        ],
        12,
        coat,
    )
    hoofed_legs(b, ORYX, 0.13, 0.9, 0.48, -0.5, 0.95, 0.07, 0.034, 1, 2, 6, 1.15)
    NP = (0.0, 1.12, 0.62)

    b.set(2, 0, 0, NP, 1)
    neck(b, [(0, 1.02, 0.6), (0, 1.22, 0.7), (0, 1.4, 0.8), (0, 1.5, 0.85)], [(0.13, 0.1, 0.2), (0.1, 0.11, 0.14), (0.085, 0.09, 0.1), (0.075, 0.075, 0.08)], 8, lambda t, a, c: 1 if math.cos(a) < -0.6 and t > 0.3 else 0)

    def face(t, a, c):
        ca, sa = math.cos(a), math.sin(a)
        if 0.3 < t < 0.85 and ca > 0.55:
            return 1  # the black blaze down the nose
        if 0.22 < t < 0.7 and abs(sa) > 0.6 and ca < 0.25:
            return 1  # the stripe through the eye to the jaw
        return 2

    b.set(2, 2, 0, NP, 1)
    head(
        b,
        [(0, 1.545, 0.835), (0, 1.54, 0.87), (0, 1.515, 0.94), (0, 1.475, 1.02), (0, 1.425, 1.1), (0, 1.39, 1.15), (0, 1.37, 1.175)],
        [(0.05, 0.045, 0.04, 0.045), (0.085, 0.07, 0.065, 0.08), (0.083, 0.06, 0.06, 0.08), (0.065, 0.05, 0.05, 0.065), (0.052, 0.046, 0.045, 0.05), (0.046, 0.042, 0.038, 0.04), (0.03, 0.028, 0.024, 0.025)],
        9,
        face,
        (0, 1.365, 1.185),
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        eye(b, (s * 0.072, 1.522, 0.95), 0.016, s)
    b.ball((0, 1.39, 1.175), (0.03, 0.018, 0.012), 5, 2, 4)  # the nose
    for s in (-1, 1):
        # long straight horns, swept back, ringed at the base
        b.set(2, 3, 0, NP, 1)
        horn(b, [(s * 0.035, 1.545, 0.9), (s * 0.06, 1.75, 0.8), (s * 0.09, 1.98, 0.67), (s * 0.12, 2.25, 0.5)], 0.024, 0.004, 5, 2, 0.18, 7)
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.055, 1.565, 0.85), (s * 0.12, 1.59, 0.825), (s * 0.175, 1.605, 0.8)], [0.028, 0.03, 0.006], 0.01, 5, 0, 6)
    b.set(3, 0, 0, (0.0, 0.98, -0.72))
    tail(b, [(0, 1.04, -0.75), (0, 0.92, -0.81), (0, 0.76, -0.85), (0, 0.6, -0.86)], [0.035, 0.03, 0.04, 0.012], 5, lambda t, a, c: 1 if t > 0.35 else 0)
    return b


def fox():
    b = Builder(FOX)
    b.set(0, 0)
    body(
        b,
        [
            (-0.2, 0.205, 0.02, 0.02, 0.02, 0.02),
            (-0.17, 0.205, 0.05, 0.045, 0.05, 0.055),
            (-0.09, 0.212, 0.062, 0.05, 0.058, 0.055),
            (0.02, 0.218, 0.066, 0.05, 0.062, 0.066),
            (0.11, 0.228, 0.055, 0.04, 0.055, 0.063),
            (0.16, 0.236, 0.03, 0.025, 0.03, 0.035),
        ],
        10,
        lambda t, a, c: 2 if belly(a) else 0,
    )
    for fx, fz, ph in ((0.045, 0.11, 0.0), (-0.045, 0.11, 0.5), (0.045, -0.13, 0.5), (-0.045, -0.13, 0.0)):
        b.set(1, 2, ph, (fx, 0.2, fz))
        if fz > 0:
            pts = [(fx * 0.7, 0.215, fz - 0.01), (fx, 0.15, fz - 0.012), (fx, 0.07, fz), (fx, 0.02, fz + 0.006), (fx, 0.008, fz + 0.022)]
            secs = [(0.016, 0.024, 0.022), (0.015, 0.017, 0.016), (0.009, 0.01, 0.01), (0.009, 0.01, 0.01), (0.009, 0.012, 0.01)]
        else:
            pts = [(fx * 0.7, 0.215, fz + 0.01), (fx, 0.15, fz + 0.025), (fx, 0.085, fz - 0.03), (fx, 0.02, fz - 0.01), (fx, 0.008, fz + 0.014)]
            secs = [(0.018, 0.034, 0.032), (0.018, 0.026, 0.024), (0.009, 0.01, 0.012), (0.009, 0.01, 0.01), (0.009, 0.012, 0.01)]
        b.tube(pts, secs, 5, (0, 0, 1), 2, None, True, (pts[-1][0], 0.0, pts[-1][2] + 0.008), 62)
    NP = (0.0, 0.24, 0.15)
    b.set(2, 0, 0, NP, 1)
    neck(b, [(0, 0.215, 0.145), (0, 0.25, 0.165), (0, 0.28, 0.185)], [(0.036, 0.022, 0.045), (0.035, 0.035, 0.04), (0.032, 0.03, 0.03)], 7)
    head(
        b,
        [(0, 0.29, 0.165), (0, 0.293, 0.185), (0, 0.288, 0.215), (0, 0.276, 0.25), (0, 0.264, 0.285), (0, 0.256, 0.312)],
        [(0.035, 0.03, 0.03, 0.03), (0.055, 0.045, 0.045, 0.04), (0.05, 0.038, 0.036, 0.038), (0.026, 0.02, 0.022, 0.022), (0.016, 0.013, 0.014, 0.014), (0.009, 0.008, 0.008, 0.008)],
        8,
        lambda t, a, c: 2 if math.cos(a) < -0.3 else 0,
        (0, 0.254, 0.322),
    )
    b.set(2, 4, 0, NP, 1)
    b.ball((0, 0.257, 0.318), 0.008, 5, 2, 4)
    for s in (-1, 1):
        eye(b, (s * 0.028, 0.298, 0.24), 0.008, s)
    for s in (-1, 1):
        # the ears: as tall as the head is long
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.026, 0.305, 0.195), (s * 0.05, 0.36, 0.188), (s * 0.072, 0.415, 0.18), (s * 0.088, 0.462, 0.172)], [0.03, 0.03, 0.02, 0.003], 0.008, 5, 0, 6, face=(0, 0, 1))
    b.set(3, 0, 0, (0.0, 0.2, -0.18))
    tail(
        b,
        [(0, 0.205, -0.17), (0, 0.18, -0.25), (0, 0.15, -0.33), (0, 0.125, -0.41), (0, 0.11, -0.465)],
        [0.02, 0.036, 0.046, 0.034, 0.004],
        5,
        lambda t, a, c: 1 if t > 0.78 else 0,
    )
    return b


def hare():
    b = Builder(HARE)
    b.set(0, 0)
    body(
        b,
        [
            prof(-0.215, 0.21, 0.14, 0.03, 0.03),
            prof(-0.19, 0.27, 0.1, 0.07, 0.065),
            prof(-0.12, 0.3, 0.09, 0.09, 0.08),
            prof(-0.03, 0.3, 0.115, 0.085, 0.07),
            prof(0.05, 0.285, 0.135, 0.07, 0.06),
            prof(0.11, 0.27, 0.165, 0.05, 0.045),
            prof(0.14, 0.26, 0.2, 0.03, 0.03),
        ],
        10,
        lambda t, a, c: 2 if belly(a) else 0,
    )
    for s in (-1, 1):
        # long hind legs folded under, both together; short front legs
        b.set(1, 0, 0.0, (s * 0.07, 0.15, -0.08))
        b.tube(
            [(s * 0.05, 0.22, -0.1), (s * 0.068, 0.17, -0.085), (s * 0.078, 0.11, -0.07), (s * 0.084, 0.055, -0.09), (s * 0.085, 0.02, -0.075), (s * 0.08, 0.011, -0.02), (s * 0.076, 0.011, 0.06)],
            [(0.03, 0.05, 0.05), (0.045, 0.07, 0.065), (0.042, 0.06, 0.055), (0.02, 0.022, 0.026), (0.014, 0.014, 0.018), (0.014, 0.011, 0.011), (0.011, 0.008, 0.008)],
            5,
            (0, 0, 1),
            lambda t, a, c: 2 if t > 0.6 and math.cos(a) < 0 else 0,
            None,
            True,
            True,
            60,
        )
        b.set(1, 0, 0.5, (s * 0.04, 0.17, 0.1))
        b.tube(
            [(s * 0.04, 0.17, 0.095), (s * 0.042, 0.1, 0.105), (s * 0.042, 0.03, 0.12), (s * 0.04, 0.008, 0.14)],
            [(0.018, 0.022, 0.02), (0.013, 0.014, 0.014), (0.01, 0.011, 0.011), (0.01, 0.012, 0.01)],
            5,
            (0, 0, 1),
            0,
            None,
            True,
            (s * 0.04, 0.0, 0.145),
            62,
        )
    NP = (0.0, 0.24, 0.13)
    b.set(2, 0, 0, NP, 1)
    neck(b, [(0, 0.2, 0.12), (0, 0.245, 0.14), (0, 0.27, 0.155)], [(0.055, 0.03, 0.065), (0.04, 0.04, 0.045), (0.036, 0.035, 0.035)], 7)
    head(
        b,
        [(0, 0.285, 0.13), (0, 0.293, 0.155), (0, 0.29, 0.19), (0, 0.278, 0.22), (0, 0.265, 0.245), (0, 0.258, 0.256)],
        [(0.03, 0.03, 0.03, 0.03), (0.046, 0.042, 0.042, 0.046), (0.044, 0.038, 0.04, 0.045), (0.032, 0.028, 0.03, 0.032), (0.02, 0.018, 0.018, 0.018), (0.008, 0.008, 0.008, 0.008)],
        8,
        lambda t, a, c: 2 if math.cos(a) < -0.4 and t > 0.4 else 0,
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        eye(b, (s * 0.037, 0.3, 0.19), 0.011, s)
    b.ball((0, 0.265, 0.25), 0.006, 4, 2, 4)
    for s in (-1, 1):
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.02, 0.31, 0.155), (s * 0.03, 0.37, 0.13), (s * 0.038, 0.44, 0.1), (s * 0.044, 0.5, 0.07)], [0.02, 0.026, 0.022, 0.004], 0.007, 5, 0, 6, 1, 0.66, face=(s * 1.0, 0.2, 0.7))
    b.set(0, 2)
    b.ball((0, 0.19, -0.205), (0.032, 0.035, 0.03), 6, 2, 2)  # the white scut
    return b


def lizard():
    b = Builder(LIZARD)

    def coat(t, a, c):
        if math.cos(a) < -0.3:
            return 2
        return 0

    b.set(0, 0)
    b.tube(
        [(0, 0.03, -0.065), (0, 0.033, -0.03), (0, 0.035, 0.02), (0, 0.035, 0.065), (0, 0.033, 0.085), (0, 0.035, 0.1), (0, 0.032, 0.12), (0, 0.027, 0.137)],
        [(0.016, 0.012, 0.012), (0.022, 0.015, 0.015), (0.025, 0.016, 0.017), (0.019, 0.013, 0.014), (0.014, 0.011, 0.011), (0.017, 0.012, 0.012), (0.012, 0.008, 0.009), (0.004, 0.003, 0.003)],
        6,
        (0, 1, 0),
        coat,
        None,
        True,
        True,
        60,
    )
    b.set(0, 4)
    for s in (-1, 1):
        b.ball((s * 0.0145, 0.04, 0.108), 0.0035, 4, 2, 4)
    b.set(3, 0, 0, (0.0, 0.03, -0.06))
    tail(b, [(0, 0.03, -0.06), (0, 0.025, -0.11), (0, 0.019, -0.17), (0, 0.014, -0.22), (0, 0.011, -0.262)], [(0.014, 0.011, 0.011), (0.01, 0.008, 0.008), (0.007, 0.006, 0.006), (0.004, 0.004, 0.004), (0.0015, 0.0015, 0.0015)], 5, lambda t, a, c: 2 if math.cos(a) < -0.3 else 0)
    for s, fz, ph in ((1, 0.05, 0.0), (-1, 0.05, 0.5), (1, -0.04, 0.5), (-1, -0.04, 0.0)):
        b.set(1, 1, ph, (s * 0.02, 0.03, fz))
        fwd = 1 if fz > 0 else -1
        b.tube(
            [(s * 0.012, 0.031, fz), (s * 0.034, 0.03, fz + 0.004 * fwd), (s * 0.046, 0.016, fz + 0.01 * fwd), (s * 0.05, 0.004, fz + 0.016), (s * 0.053, 0.002, fz + 0.03)],
            [0.008, 0.0065, 0.005, 0.004, 0.0025],
            4,
            (0, 1, 0),
            1,
            None,
            True,
            True,
            70,
        )
    return b


def vulture():
    b = Builder(VULTURE)
    b.set(0, 0)
    body(
        b,
        [
            (-0.36, 0.0, 0.05, 0.05, 0.035, 0.035),
            (-0.3, 0.0, 0.09, 0.08, 0.06, 0.06),
            (-0.12, 0.0, 0.14, 0.12, 0.11, 0.12),
            (0.08, 0.01, 0.14, 0.12, 0.11, 0.13),
            (0.24, 0.025, 0.11, 0.1, 0.09, 0.1),
            (0.33, 0.035, 0.07, 0.07, 0.07, 0.07),
        ],
        10,
    )
    # the pale ruff round the base of the neck
    b.set(0, 2)
    b.tube([(0, 0.035, 0.3), (0, 0.04, 0.345), (0, 0.042, 0.385), (0, 0.044, 0.41)], [(0.08, 0.075, 0.08), (0.105, 0.095, 0.1), (0.085, 0.08, 0.085), (0.04, 0.04, 0.04)], 10, (0, 1, 0), 2, None, False, False, 50, 0.0, lambda i, a: 1 + 0.12 * math.cos(5 * a) * (1 if i in (1, 2) else 0))
    # the bare neck and head, and the hooked beak
    b.tube(
        [(0, 0.04, 0.38), (0, 0.06, 0.46), (0, 0.065, 0.53), (0, 0.06, 0.575), (0, 0.05, 0.61)],
        [0.035, 0.03, (0.04, 0.035, 0.035), (0.04, 0.04, 0.035), (0.03, 0.028, 0.028)],
        7,
        (0, 1, 0),
        2,
        None,
        False,
        False,
        60,
    )
    b.set(0, 3)
    b.tube([(0, 0.05, 0.6), (0, 0.05, 0.635), (0, 0.04, 0.66), (0, 0.015, 0.672)], [(0.02, 0.025, 0.018), (0.014, 0.02, 0.012), (0.009, 0.014, 0.008), 0.003], 5, (0, 1, 0), 3, None, False, True, 70)
    b.set(0, 4)
    for s in (-1, 1):
        b.ball((s * 0.034, 0.068, 0.565), 0.008, 4, 2, 4)
    # tail fan: overlapping wide feathers, a ragged end
    b.set(0, 1)
    rows = []
    for zz, w, y in ((-0.3, 0.07, 0.01), (-0.45, 0.13, 0.005), (-0.6, 0.17, 0.0)):
        row = []
        for k in range(7):
            u = k / 6 * 2 - 1
            zt = zz - (0.03 * (k % 2) if zz < -0.55 else 0.0)
            row.append((u * w, y + 0.012 * (1 - u * u), zt))
        rows.append(row)
    b.sheet(rows, 1)
    for s in (-1, 1):
        # broad wings: coverts over the arm, the flight feathers behind in a serrated row, the
        # hand, and six separate primaries fanned at the tip, curling up
        b.set(5, 0, 0, (s * 0.12, 0.02, 0.0), s)

        def P(x, z, lift=0.0, s=s):
            return (s * x, 0.02 - 0.03 * x + lift, z)

        stations = [0.08, 0.3, 0.55, 0.8, 1.02]
        lead = [0.17, 0.19, 0.18, 0.15, 0.11]
        cov = [-0.12, -0.13, -0.12, -0.1, -0.08]
        thick = [0.05, 0.04, 0.03, 0.022, 0.015]
        rings = []
        for x, le, te, th in zip(stations, lead, cov, thick):
            ring = []
            # top surface leading -> trailing, then bottom trailing -> leading
            for u, tt in ((0.0, 0.0), (0.25, 0.9), (0.55, 0.8), (1.0, 0.1)):
                ring.append(P(x, mix(le, te, u), th * tt * 0.6))
            for u, tt in ((0.55, -0.3), (0.25, -0.4)):
                ring.append(P(x, mix(le, te, u), th * tt * 0.6))
            rings.append(ring if s > 0 else list(reversed(ring)))
        b.grid(rings, True, 0, None, None, None, 50)
        # the flight feathers: a serrated row from the arm out to the hand
        b.set(5, 1, 0, (s * 0.12, 0.02, 0.0), s)
        top, tip = [], []
        nf = 10
        for k in range(nf * 2 + 1):
            x = mix(0.1, 1.0, k / (nf * 2))
            te = mix(-0.33, -0.27, k / (nf * 2))
            top.append(P(x, -0.08, 0.004))
            tip.append(P(x, te - (0.035 if k % 2 == 1 else 0.0), -0.004))
        b.sheet([top, tip], 1)
        # the hand: dark, narrowing to the fingers
        hand = []
        for x, le, te in ((0.98, 0.115, -0.3), (1.12, 0.09, -0.26), (1.22, 0.06, -0.2)):
            hand.append([P(x, le, 0.006), P(x, mix(le, te, 0.5), 0.01), P(x, te, 0.0), P(x, mix(le, te, 0.5), -0.004)])
        b.grid(hand if s > 0 else [list(reversed(r)) for r in hand], True, 1, None, None, None, 50)
        # six primaries, separated, spread like fingers
        for k in range(6):
            z0 = mix(0.05, -0.19, k / 5)
            ang = mix(0.25, -0.45, k / 5)
            ln = 0.3 + 0.06 * math.sin(k / 5 * math.pi)
            base = (1.2, z0)
            d = (math.cos(ang), math.sin(ang))
            sd = (-d[1], d[0])
            w = 0.03
            pts = []
            for u, ww, lift in ((0.0, 1.0, 0.0), (0.45, 1.0, 0.02), (0.8, 0.7, 0.045), (1.0, 0.0, 0.07)):
                cx, cz = base[0] + d[0] * ln * u, base[1] + d[1] * ln * u
                pts.append((P(cx + sd[0] * w * ww, cz + sd[1] * w * ww, lift), P(cx - sd[0] * w * ww, cz - sd[1] * w * ww, lift)))
            rows = [[a, c] for a, c in pts]
            b.sheet(rows, 1)
    return b


def gazelle():
    b = Builder(GAZELLE)

    def coat(t, a, c):
        if belly(a):
            return 2  # white belly
        if low_side(a) and -0.32 < c[2] < 0.34:
            return 1  # the dark band along the flank
        if c[2] < -0.4 and math.cos(a) < 0.3:
            return 2  # the pale rump
        return 0

    b.set(0, 0)
    body(
        b,
        [
            prof(-0.47, 0.71, 0.6, 0.03, 0.03),
            prof(-0.435, 0.765, 0.53, 0.08, 0.07),
            prof(-0.33, 0.795, 0.5, 0.12, 0.1),
            prof(-0.18, 0.79, 0.55, 0.125, 0.1),
            prof(0.0, 0.79, 0.51, 0.13, 0.11),
            prof(0.17, 0.805, 0.48, 0.135, 0.105),
            prof(0.3, 0.83, 0.48, 0.12, 0.09),
            prof(0.39, 0.82, 0.56, 0.085, 0.065),
            prof(0.44, 0.78, 0.66, 0.03, 0.03),
        ],
        12,
        coat,
    )
    hoofed_legs(b, GAZELLE, 0.075, 0.6, 0.3, -0.31, 0.62, 0.042, 0.018, 0, 2, 5, 1.1)
    NP = (0.0, 0.72, 0.38)
    b.set(2, 0, 0, NP, 1)
    neck(b, [(0, 0.67, 0.37), (0, 0.8, 0.45), (0, 0.92, 0.5), (0, 0.99, 0.53)], [(0.065, 0.05, 0.1), (0.05, 0.055, 0.06), (0.042, 0.045, 0.048), (0.04, 0.04, 0.04)], 7, lambda t, a, c: 2 if math.cos(a) < -0.5 and t > 0.4 else 0)

    def face(t, a, c):
        ca, sa = math.cos(a), math.sin(a)
        if 0.25 < t < 0.9 and abs(sa) > 0.55 and -0.2 < ca < 0.45:
            return 1  # the dark cheek stripe
        if 0.2 < t < 0.9 and ca > 0.5:
            return 0
        return 2

    b.set(2, 2, 0, NP, 1)
    head(
        b,
        [(0, 1.02, 0.5), (0, 1.02, 0.53), (0, 1.005, 0.58), (0, 0.98, 0.63), (0, 0.95, 0.675), (0, 0.93, 0.705), (0, 0.922, 0.716)],
        [(0.03, 0.028, 0.025, 0.028), (0.048, 0.04, 0.04, 0.045), (0.045, 0.035, 0.036, 0.045), (0.034, 0.028, 0.03, 0.036), (0.026, 0.024, 0.024, 0.026), (0.022, 0.02, 0.018, 0.018), (0.014, 0.012, 0.01, 0.01)],
        9,
        face,
        (0, 0.92, 0.722),
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        eye(b, (s * 0.04, 1.015, 0.585), 0.011, s)
    b.ball((0, 0.935, 0.715), (0.016, 0.01, 0.008), 5, 2, 4)
    for s in (-1, 1):
        # lyre horns: up, out, and the tips turned in, ringed
        b.set(2, 3, 0, NP, 1)
        horn(b, [(s * 0.02, 1.045, 0.54), (s * 0.045, 1.14, 0.48), (s * 0.055, 1.23, 0.45), (s * 0.04, 1.3, 0.47), (s * 0.028, 1.34, 0.51)], 0.014, 0.003, 5, 2, 0.22, 9)
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.035, 1.045, 0.51), (s * 0.08, 1.08, 0.48), (s * 0.115, 1.1, 0.46), (s * 0.135, 1.11, 0.445)], [0.018, 0.024, 0.018, 0.004], 0.006, 5, 0, 6)
    b.set(3, 1, 0, (0.0, 0.64, -0.43))
    tail(b, [(0, 0.66, -0.44), (0, 0.6, -0.475), (0, 0.53, -0.49)], [0.018, 0.016, 0.01], 5, 1)
    return b


def ass():
    b = Builder(ASS)

    def coat(t, a, c):
        if belly(a) or (c[2] > 0.5 and math.cos(a) < -0.3):
            return 2  # pale belly and chest
        return 0

    st = [
            prof(-0.79, 1.16, 1.0, 0.05, 0.05),
            prof(-0.74, 1.26, 0.84, 0.17, 0.15),
            prof(-0.59, 1.31, 0.75, 0.25, 0.22),
            prof(-0.36, 1.31, 0.77, 0.265, 0.23),
            prof(-0.08, 1.3, 0.72, 0.275, 0.24),
            prof(0.2, 1.315, 0.7, 0.275, 0.23),
            prof(0.42, 1.34, 0.71, 0.245, 0.19),
            prof(0.58, 1.32, 0.8, 0.18, 0.14),
            prof(0.68, 1.27, 0.92, 0.1, 0.09),
            prof(0.73, 1.2, 1.02, 0.04, 0.04),
    ]
    b.set(0, 0)
    body(b, st, 12, coat)
    # the dark stripe down the spine, from the rump to the withers, lying along the top of the back
    b.set(0, 1)
    spine = [(0.0, s[1] + s[4] - 0.003, s[0]) for s in st[1:-2]]
    b.tube(spine, [(0.024, 0.008, 0.004)] + [(0.034, 0.008, 0.004)] * (len(spine) - 2) + [(0.02, 0.006, 0.004)], 4, (0, 1, 0), 1, None, True, True, 40)
    hoofed_legs(b, ASS, 0.13, 0.94, 0.44, -0.47, 0.97, 0.072, 0.038, 0, 2, 6, 1.15)
    NP = (0.0, 1.12, 0.58)
    b.set(2, 0, 0, NP, 1)
    npath = [(0, 1.02, 0.56), (0, 1.22, 0.67), (0, 1.4, 0.78), (0, 1.5, 0.84)]
    nsecs = [(0.14, 0.11, 0.22), (0.1, 0.12, 0.15), (0.085, 0.105, 0.12), (0.08, 0.09, 0.1)]
    neck(b, npath, nsecs, 8, lambda t, a, c: 2 if math.cos(a) < -0.7 and t < 0.6 else 0)
    # the short mane standing up along the crest of the neck, from the withers to the poll
    b.set(2, 1, 0, NP, 1)
    ridge, _ = catmull(crest(npath, nsecs)[1:], 2)
    ridge = [(0, 1.22, 0.585)] + ridge + [(0, 1.6, 0.85)]
    t = norm(sub(npath[-1], npath[0]))
    b.tube(ridge, [(0.012, 0.03, 0.0)] + [(0.02, 0.055, 0.0)] * (len(ridge) - 2) + [(0.012, 0.03, 0.0)], 6, (0.0, t[2], -t[1]), 1, None, True, True, 50)

    def face(t, a, c):
        return 2 if t > 0.7 else 0

    b.set(2, 0, 0, NP, 1)
    head(
        b,
        [(0, 1.55, 0.82), (0, 1.545, 0.86), (0, 1.505, 0.94), (0, 1.445, 1.03), (0, 1.38, 1.1), (0, 1.32, 1.16), (0, 1.28, 1.2), (0, 1.265, 1.215)],
        [(0.06, 0.06, 0.05, 0.06), (0.095, 0.085, 0.075, 0.1), (0.092, 0.08, 0.07, 0.11), (0.078, 0.07, 0.06, 0.09), (0.068, 0.065, 0.055, 0.075), (0.07, 0.068, 0.06, 0.07), (0.06, 0.056, 0.05, 0.055), (0.035, 0.03, 0.03, 0.03)],
        10,
        face,
        (0, 1.26, 1.222),
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        eye(b, (s * 0.083, 1.52, 0.95), 0.017, s)
        b.ball((s * 0.03, 1.3, 1.2), (0.012, 0.012, 0.008), 4, 2, 4)
    b.ball((0, 1.245, 1.19), (0.045, 0.008, 0.02), 5, 2, 4)  # the mouth line
    for s in (-1, 1):
        # long ears, the first thing you see of one over a dune
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.045, 1.56, 0.875), (s * 0.075, 1.65, 0.86), (s * 0.11, 1.75, 0.835), (s * 0.13, 1.84, 0.805)], [0.03, 0.042, 0.036, 0.005], 0.013, 5, 0, 6, 1, 0.66, face=(s * 0.45, 0, 1))
    b.set(3, 0, 0, (0.0, 1.04, -0.72))
    tail(b, [(0, 1.08, -0.74), (0, 0.98, -0.8), (0, 0.82, -0.83), (0, 0.68, -0.85), (0, 0.56, -0.86)], [0.035, 0.026, 0.02, 0.042, 0.012], 5, lambda t, a, c: 1 if t > 0.6 else 0)
    return b


def goat():
    b = Builder(GOAT)
    b.set(0, 0)
    body(
        b,
        [
            prof(-0.39, 0.66, 0.52, 0.03, 0.03),
            prof(-0.355, 0.72, 0.45, 0.1, 0.09),
            prof(-0.24, 0.77, 0.41, 0.15, 0.13),
            prof(-0.08, 0.765, 0.43, 0.16, 0.14),
            prof(0.1, 0.775, 0.4, 0.165, 0.14),
            prof(0.25, 0.8, 0.42, 0.14, 0.11),
            prof(0.34, 0.78, 0.5, 0.095, 0.075),
            prof(0.39, 0.72, 0.6, 0.03, 0.03),
        ],
        12,
    )
    hoofed_legs(b, GOAT, 0.075, 0.54, 0.25, -0.26, 0.56, 0.045, 0.022, 0, 0, 5, 1.1)
    NP = (0.0, 0.64, 0.33)
    b.set(2, 0, 0, NP, 1)
    neck(b, [(0, 0.6, 0.32), (0, 0.72, 0.39), (0, 0.82, 0.43), (0, 0.87, 0.45)], [(0.075, 0.06, 0.11), (0.06, 0.07, 0.08), (0.05, 0.055, 0.06), (0.048, 0.05, 0.05)], 7)
    head(
        b,
        [(0, 0.895, 0.425), (0, 0.9, 0.45), (0, 0.885, 0.5), (0, 0.85, 0.55), (0, 0.8, 0.6), (0, 0.76, 0.628), (0, 0.745, 0.638)],
        [(0.035, 0.032, 0.03, 0.03), (0.055, 0.045, 0.045, 0.05), (0.052, 0.04, 0.04, 0.05), (0.04, 0.032, 0.032, 0.04), (0.03, 0.028, 0.026, 0.03), (0.026, 0.024, 0.02, 0.022), (0.016, 0.014, 0.012, 0.012)],
        9,
        lambda t, a, c: 2 if t > 0.82 else 0,
        (0, 0.742, 0.644),
    )
    b.set(2, 1, 0, NP, 1)
    b.tube([(0, 0.745, 0.6), (0, 0.7, 0.592), (0, 0.65, 0.585), (0, 0.615, 0.578)], [(0.016, 0.014, 0.014), (0.014, 0.014, 0.012), (0.01, 0.01, 0.01), 0.003], 5, (0, 0, 1), 1, None, True, True, 60)
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        eye(b, (s * 0.046, 0.875, 0.515), 0.011, s)
    b.ball((0, 0.765, 0.635), (0.018, 0.01, 0.008), 4, 2, 4)
    for s in (-1, 1):
        # horns swept back over the neck in a curve
        b.set(2, 3, 0, NP, 1)
        horn(b, [(s * 0.026, 0.92, 0.48), (s * 0.04, 0.98, 0.44), (s * 0.06, 1.0, 0.37), (s * 0.075, 0.97, 0.3), (s * 0.085, 0.92, 0.26)], 0.018, 0.003, 5, 2, 0.12, 8)
        # ears that hang out to the side
        b.set(4, 0, 0, NP, 1, s)
        ear(b, [(s * 0.045, 0.89, 0.465), (s * 0.09, 0.865, 0.47), (s * 0.135, 0.83, 0.47), (s * 0.165, 0.8, 0.465)], [0.022, 0.03, 0.024, 0.005], 0.008, 5, 0, 6, face=(0, -1, 0.2))
    b.set(3, 0, 0, (0.0, 0.64, -0.36))
    tail(b, [(0, 0.63, -0.36), (0, 0.67, -0.4), (0, 0.72, -0.43)], [(0.026, 0.02, 0.02), 0.018, 0.004], 5, 0)
    return b


def tortoise():
    b = Builder(TORTOISE)
    A, C, RIM, H = 0.16, 0.2, 0.05, 0.135

    def dome(r, th):
        """A point of the shell at radius r (0 top .. 1 rim, beyond 1 the flared margin), angle th."""
        if r <= 1:
            y = RIM + H * (1 - r * r) ** 0.62
        else:
            y = RIM - (r - 1) * 0.25
        return (A * r * math.sin(th), y, C * r * math.cos(th))

    def on_dome(x, z, lift):
        r = math.sqrt((x / A) ** 2 + (z / C) ** 2)
        th = math.atan2(x / A, z / C)
        p = dome(min(r, 1.0), th)
        # push out along the rough surface normal
        nrm = norm((x / (A * A), (p[1] - RIM + 0.05) / (H * H) * 0.2, z / (C * C)))
        return add(p, mul(nrm, lift))

    # the dark ground of the shell, the seams between the plates
    b.set(0, 1)
    n = 16
    rows = [[dome(r, k / n * TAU) for k in range(n)] for r in (0.3, 0.62, 0.88, 1.0, 1.07)]
    rows.append([(A * 0.98 * math.sin(k / n * TAU), 0.03, C * 0.98 * math.cos(k / n * TAU)) for k in range(n)])
    # rows run from the top down: reverse them so the grid winds outward
    rows = rows[::-1]
    b.grid(rows, True, 1, None, (0, 0.025, 0), (0, RIM + H, 0), 50)
    # the plates: five down the spine, four each side, raised a little and domed
    plates = [(0.0, z, 0.05, 0.036) for z in (-0.13, -0.065, 0.0, 0.065, 0.13)]
    for s in (-1, 1):
        for z in (-0.105, -0.035, 0.035, 0.105):
            plates.append((s * 0.093, z, 0.036, 0.034))
    b.set(0, 0)
    for px, pz, rx, rz in plates:
        outer = []
        for k in range(6):
            a = k / 6 * TAU + math.pi / 6
            outer.append(on_dome(px + math.sin(a) * rx * 0.92, pz + math.cos(a) * rz * 0.92, 0.002))
        b.grid([outer], True, 0, None, None, on_dome(px, pz, 0.01), 30)
    # the margin: a ring of small plates round the rim
    m = 16
    for k in range(m):
        a0, a1 = (k + 0.1) / m * TAU, (k + 0.9) / m * TAU
        r0, r1 = 0.93, 1.06
        quad = [[dome(r0, a0), dome(r0, a1)], [dome(r1, a0), dome(r1, a1)]]
        lifted = [[add(p, (0, 0.003, 0)) for p in row] for row in quad]
        b.sheet(lifted, 0)
    for s, fz, ph in ((1, 0.1, 0.0), (-1, 0.1, 0.5), (1, -0.1, 0.5), (-1, -0.1, 0.0)):
        b.set(1, 2, ph, (s * 0.11, 0.06, fz))
        b.tube([(s * 0.09, 0.07, fz), (s * 0.12, 0.045, fz + 0.005), (s * 0.135, 0.015, fz + 0.012), (s * 0.138, 0.0, fz + 0.016)], [0.026, 0.03, 0.03, (0.034, 0.036, 0.03)], 6, (0, 0, 1), 2, None, True, True, 60)
        b.set(1, 3, ph, (s * 0.11, 0.06, fz))
        for c in (-1, 1):
            b.tube([(s * 0.138 + c * 0.01, 0.006, fz + 0.03), (s * 0.138 + c * 0.012, 0.002, fz + 0.046)], [0.005, 0.001], 3, (0, 1, 0), 3, None, False, True, 80)
    NP = (0.0, 0.06, 0.17)
    b.set(2, 2, 0, NP, 1)
    b.tube(
        [(0, 0.05, 0.12), (0, 0.058, 0.18), (0, 0.072, 0.23), (0, 0.08, 0.255), (0, 0.078, 0.28), (0, 0.07, 0.297)],
        [(0.026, 0.024, 0.024), (0.024, 0.022, 0.024), (0.022, 0.02, 0.022), (0.03, 0.026, 0.024), (0.026, 0.022, 0.02), (0.014, 0.012, 0.01)],
        7,
        (0, 1, 0),
        2,
        None,
        True,
        True,
        60,
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        b.ball((s * 0.025, 0.086, 0.265), 0.006, 4, 2, 4)
    b.set(0, 2)
    b.tube([(0, 0.04, -0.17), (0, 0.03, -0.215)], [0.014, 0.003], 4, (0, 1, 0), 2, None, True, True, 70)
    return b


def snake():
    b = Builder(SNAKE)
    pts, secs = [], []
    N = 26
    for i in range(N + 1):
        t = i / N
        z = mix(-0.33, 0.255, t)
        r = 0.005 + 0.014 * math.sin(min(1.0, t * 1.2) * math.pi * 0.5) ** 0.8
        if t > 0.86:
            r *= mix(1.0, 0.72, smoothstep(0.86, 0.92, t))  # the neck
        pts.append((0, 0.015, z))
        secs.append((r * 1.2, r * 0.75, r * 0.8))
    # the head: wider than the neck, flat, a blunt snout
    for z, rx, ry in ((0.27, 0.016, 0.009), (0.29, 0.017, 0.009), (0.305, 0.012, 0.007), (0.315, 0.005, 0.004)):
        pts.append((0, 0.015, z))
        secs.append((rx, ry, ry * 0.9))

    def coat(t, a, c):
        ca = math.cos(a)
        if ca < -0.4:
            return 2
        if ca > 0.3 and c[2] < 0.25 and int((c[2] + 1.0) / 0.045) % 2 == 0:
            return 1  # dark blotches along the back
        return 0

    b.set(0, 0)
    b.tube(pts, secs, 6, (0, 1, 0), coat, None, True, True, 60)
    b.set(0, 0)
    for s in (-1, 1):
        # the little horns over the eyes
        b.tube([(s * 0.011, 0.022, 0.282), (s * 0.012, 0.03, 0.29)], [0.0035, 0.0008], 4, (0, 0, 1), 0, None, True, True, 70)
    b.set(0, 4)
    for s in (-1, 1):
        b.ball((s * 0.0135, 0.02, 0.294), 0.003, 4, 2, 4)
    return b


def grouse():
    b = Builder(GROUSE)

    def coat(t, a, c):
        x, y, z = c
        if z > 0.035 and y < 0.14:
            return 2  # the pale breast
        if 0.0 < z < 0.035 and y < 0.13:
            return 1  # the dark breast band
        return 0

    b.set(0, 0)
    body(
        b,
        [
            (-0.14, 0.11, 0.02, 0.02, 0.015, 0.015),
            (-0.11, 0.112, 0.04, 0.035, 0.035, 0.03),
            (-0.05, 0.118, 0.062, 0.055, 0.058, 0.055),
            (0.02, 0.125, 0.066, 0.058, 0.06, 0.065),
            (0.07, 0.138, 0.05, 0.045, 0.05, 0.055),
            (0.095, 0.15, 0.025, 0.025, 0.025, 0.028),
        ],
        10,
        coat,
    )
    b.set(0, 1)
    b.tube([(0, 0.112, -0.12), (0, 0.112, -0.18), (0, 0.113, -0.245)], [(0.018, 0.006, 0.005), (0.01, 0.005, 0.004), (0.002, 0.002, 0.002)], 4, (0, 1, 0), 1, None, True, True, 60)
    for s, ph in ((1, 0.0), (-1, 0.5)):
        b.set(1, 2, ph, (s * 0.025, 0.08, 0.0))
        b.tube([(s * 0.025, 0.09, 0.0), (s * 0.025, 0.04, 0.008), (s * 0.025, 0.006, 0.012), (s * 0.025, 0.004, 0.03)], [0.012, 0.006, 0.005, 0.003], 4, (0, 0, 1), 2, None, True, True, 70)
    NP = (0.0, 0.145, 0.08)
    b.set(2, 0, 0, NP, 1)
    b.tube(
        [(0, 0.14, 0.07), (0, 0.17, 0.09), (0, 0.19, 0.105), (0, 0.192, 0.125), (0, 0.186, 0.142), (0, 0.18, 0.152), (0, 0.176, 0.162)],
        [(0.03, 0.032, 0.034), (0.03, 0.03, 0.03), (0.032, 0.031, 0.031), (0.026, 0.024, 0.024), (0.014, 0.012, 0.012), (0.007, 0.005, 0.006), 0.002],
        7,
        (0, 1, 0),
        lambda t, a, c: 3 if t > 0.75 else 0,
        None,
        True,
        True,
        60,
    )
    b.set(2, 4, 0, NP, 1)
    for s in (-1, 1):
        b.ball((s * 0.027, 0.197, 0.118), 0.0065, 4, 2, 4)
    for s in (-1, 1):
        # wings spread along x; on the ground the shader folds them back along the flanks
        b.set(5, 0, 0, (s * 0.05, 0.14, 0.03), s)

        def P(x, z, lift=0.0, s=s):
            return (s * x, 0.14 + lift, z)

        rings = []
        for x, le, te, th in ((0.04, 0.065, -0.085, 0.014), (0.13, 0.06, -0.08, 0.01), (0.21, 0.045, -0.07, 0.006)):
            ring = [P(x, le, 0), P(x, mix(le, te, 0.3), th), P(x, te, 0), P(x, mix(le, te, 0.3), -th * 0.5)]
            rings.append(ring if s > 0 else list(reversed(ring)))
        b.grid(rings, True, 0, None, None, None, 50)
        b.set(5, 1, 0, (s * 0.05, 0.14, 0.03), s)
        # the long pointed outer primaries
        b.sheet([[P(0.2, 0.045, 0.002), P(0.2, -0.07, 0.002)], [P(0.27, 0.02, 0.002), P(0.27, -0.05, 0.002)], [P(0.335, -0.035, 0.002), P(0.33, -0.042, 0.002)]], 1)
    return b


BUILDERS = [oryx, fox, hare, lizard, vulture, gazelle, ass, goat, tortoise, snake, grouse]

# ---------------------------------------------------------------- normals and the final vertices


def finish(b):
    """Corner normals smoothed across each piece within its crease angle, then the vertices made
    unique by (position, normal, attributes). Returns pos, nrm, rig, piv, mp, tris.
    A closed piece wound inward is turned round first, so every normal points out."""
    if b.sp != VULTURE:
        b.pos = [(p[0], max(0.0, p[1]), p[2]) for p in b.pos]  # nothing below the ground
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
    fn = []
    for a, c1, c2 in b.tris:
        n = cross(sub(b.pos[c1], b.pos[a]), sub(b.pos[c2], b.pos[a]))
        fn.append(n)
    at = {}
    for f, t in enumerate(b.tris):
        for v in t:
            key = (b.piece[v], round(b.pos[v][0], 6), round(b.pos[v][1], 6), round(b.pos[v][2], 6))
            at.setdefault(key, []).append(f)
    out_pos, out_nrm, out_rig, out_piv, out_mp, out_tris = [], [], [], [], [], []
    index = {}
    for f, t in enumerate(b.tris):
        nf = norm(fn[f])
        tri = []
        for v in t:
            key = (b.piece[v], round(b.pos[v][0], 6), round(b.pos[v][1], 6), round(b.pos[v][2], 6))
            cos_lim = b.crease[b.piece[v]]
            acc = (0.0, 0.0, 0.0)
            for g in at[key]:
                if dot(nf, norm(fn[g])) >= cos_lim:
                    acc = add(acc, fn[g])
            nv = norm(acc) if length(acc) > 1e-12 else nf
            ukey = (key, round(nv[0], 3), round(nv[1], 3), round(nv[2], 3), b.rig[v], b.piv[v], b.mat[v])
            if ukey not in index:
                index[ukey] = len(out_pos)
                out_pos.append(b.pos[v])
                out_nrm.append(nv)
                out_rig.append(b.rig[v])
                out_piv.append(b.piv[v])
                out_mp.append((float(b.mat[v]), float(b.sp)))
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


def export(models):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for sp, (pos, nrm, rig, piv, mp, tris) in enumerate(models):
        ob = make_mesh(NAMES[sp], pos, nrm, tris)
        me = ob.data
        # the exporter drops 4-wide attributes: aRig goes as two pairs, joined again in fauna.ts
        set_attr(me, "_arig", "FLOAT2", [(r[0], r[1]) for r in rig])
        set_attr(me, "_arigzw", "FLOAT2", [(r[2], r[3]) for r in rig])
        set_attr(me, "_apivot", "FLOAT_VECTOR", piv)
        # aMP.y, the species, is the same for the whole mesh: fauna.ts sets it from the mesh name
        set_attr(me, "_amat", "FLOAT", [(m[0],) for m in mp])
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


def rot_x(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c)


def rot_y(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c)


def rot_z(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2])


def posed(model, sp, walk=0.0, ph=0.0, pose=0.0, g=None):
    """The vertex shader's pose of the rest mesh (legs, head, tail, wings; not the bob or waves)."""
    pos, nrm, rig, piv, mp, tris = model
    out = []
    g = walk if g is None else g
    for p, (o, kind, z, w), pv in zip(pos, rig, piv):
        q = sub(p, pv)
        if kind == 1:
            amp = 0.9 if sp in (HARE, LIZARD) else 0.75 if sp == GROUSE else 0.5 if sp == TORTOISE else 0.45
            q = rot_x(q, amp * walk * math.sin(TAU * (ph + o)))
        elif kind in (2, 4):
            pitch = pose * 1.35 * z
            if sp == TORTOISE:
                q = (q[0], q[1], q[2] - 0.11 * pose)
                pitch = 0.0
            q = rot_x(q, pitch)
        elif kind == 5:
            if sp == GROUSE:
                fly = max(0.0, min(1.0, g - 2.0))
                flap = z * (fly * (0.95 * math.sin(TAU * ph) + 0.15) - 0.35 * (1 - fly))
                q = rot_y(rot_z(q, flap), z * 1.4 * (1 - fly))
            else:
                q = rot_z(q, z * (g * math.sin(TAU * ph) + 0.08))
        out.append(add(pv, q))
    return out


def colour(sp, m):
    c = COAT[sp]
    if m == 0:
        return c
    if m == 1:
        return tuple(x * 0.42 for x in c)
    if m == 2:
        return tuple(mix(x, y, 0.6) for x, y in zip(c, (0.95, 0.92, 0.86)))
    if m == 3:
        return (0.13, 0.11, 0.1)
    if m == 4:
        return (0.05, 0.04, 0.04)
    return (c[0] * 1.08, c[1] * 0.82, c[2] * 0.76)


def preview(models, out_dir):
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

    def build(sp, pos, x_off=0.0, y_up=0.0):
        model = models[sp]
        ob = make_mesh(f"{NAMES[sp]}_p", [add(p, (x_off, y_up, 0)) for p in pos], model[1], model[5])
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for m in model[4] for c in (*colour(sp, int(m[0])), 1.0)])
        ob.data.materials.append(mat)
        return ob

    def aim(target, eye):
        d = sub(target, eye)
        cam.location = eye
        cam.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[0], -d[1]) + math.pi)

    def shoot(path):
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    for sp, model in enumerate(models):
        if preview_filter is not None and sp not in preview_filter:
            continue
        pos = model[0]
        lift = 0.6 if sp == VULTURE else 0.0
        xs = [p[0] for p in pos]
        ys = [p[1] for p in pos]
        zs = [p[2] for p in pos]
        size = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
        cy = (min(ys) + max(ys)) / 2 + lift
        cz = (min(zs) + max(zs)) / 2
        obs = [build(sp, pos, 0.0, lift)]
        cam.data.ortho_scale = max(max(zs) - min(zs), (max(ys) - min(ys)) / 0.7) * 1.15
        # side: the camera off the animal's left (game -x), so the head points right in the image
        aim((0, -cz, cy), (-10, -cz, cy))
        shoot(os.path.join(out_dir, f"{sp:02d}_{NAMES[sp]}_side.png"))
        # three-quarter front, from above
        aim((0, -cz, cy), (7, -cz - 8, cy + 5))
        shoot(os.path.join(out_dir, f"{sp:02d}_{NAMES[sp]}_34.png"))
        for o in obs:
            bpy.data.objects.remove(o)
        # poses: mid stride and head down (or wings) beside the rest pose
        span = size * 1.15
        if sp == VULTURE:
            poses = [posed(model, sp, g=0.5, ph=0.25), posed(model, sp, g=0.5, ph=0.75)]
        elif sp == GROUSE:
            poses = [posed(model, sp, g=0.0), posed(model, sp, g=3.0, ph=0.25)]
        else:
            poses = [posed(model, sp, walk=1.0, ph=0.25), posed(model, sp, pose=1.0)]
        obs = [build(sp, p, 0.0, lift) for p in poses]
        obs[0].location.x = -span / 2
        obs[1].location.x = span / 2
        cam.data.ortho_scale = size * 2.4
        aim((0, -cz, cy), (6, -cz - 9, cy + 4))
        shoot(os.path.join(out_dir, f"{sp:02d}_{NAMES[sp]}_poses.png"))
        for o in obs:
            bpy.data.objects.remove(o)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    only = None
    if "--only" in argv:
        only = [NAMES.index(n) for n in argv[argv.index("--only") + 1].split(",")]
    models = [finish(f()) for f in BUILDERS]
    if only is None:
        export(models)
    for sp, m in enumerate(models):
        print("FAUNA", NAMES[sp], "verts", len(m[0]), "tris", len(m[5]))
    print("FAUNA total tris", sum(len(m[5]) for m in models), "verts", sum(len(m[0]) for m in models))
    if "--preview" in argv:
        if only is not None:
            keep = [m if i in only else None for i, m in enumerate(models)]
            preview_some(keep, argv[argv.index("--preview") + 1])
        else:
            preview(models, argv[argv.index("--preview") + 1])


def preview_some(models, out_dir):
    full = [m if m is not None else ([(0, 0, 0)], [(0, 1, 0)], [(0, 0, 0, 0)], [(0, 0, 0)], [(0, 0)], []) for m in models]
    global preview_filter
    preview_filter = [i for i, m in enumerate(models) if m is not None]
    preview(full, out_dir)


preview_filter = None
main()
