"""Street and market furniture for the towns, exported to public/art/furniture.glb.

    blender --background --python tools/blender/furniture.py                   # write the .glb
    blender --background --python tools/blender/furniture.py -- --preview DIR  # and render each model

Built in the game's own frame (metres, +Y up) and turned into Blender's Z-up frame only when the
mesh is made, so the exporter's +Y-up conversion gives back exactly these numbers. No materials,
no normals (the game works them out from the winding; hard edges are split vertices), all
triangles wound outward.

The models stand in for the procedural props of src/city/extra/furniture.ts and are drawn in the
frame that file sizes them in; the game scales them per placement:

  Jar0..2      clay water jar, kind 0: height 1, widest radius 0.37, foot at y 0 (scaled by s)
  Amphora0..1  kind 1: height 1.02, widest 0.24, two loop handles
  Jug0..1      kind 2: height 0.84, widest 0.25, one handle on Jug1
  Sack0..2     unit radius, unit height (scaled by r and h): slumped, a fold, tied neck
  Basket0..2   rim radius 1 at y 0.62 (scaled by r and h): woven, goods (0), handles (1), lid (2)
  CrateShut0..1, CrateOpen0..1
               half sizes 0.29 along x (the crate's u), 0.25 along z (across), height 0.42; the game
               scales each axis to the crate's own hu, hn, hh. Corner posts, slats, lid planks
  Bench0       wooden bench, two slab legs, seat half length 0.7 along x, metres
  Bench1       three legs, seat half length 1.05 along x
  Cart0..1     handcart in metres, bed along x (shafts toward +x), wheels across z
  Lantern0..1  pierced-metal lantern hanging from its hook at y 0 down to y -0.40, metres

Every vertex carries
  _info (vec3)  x part: 0 body (the prop's own material, y a signed tint offset / 255),
                        1 dark opening (y unused), 2 goods (cloth in the goods colour, y a signed
                        offset), 3 rope (wood, y the tint 0..1), 4 iron (y the tint 0..1),
                        5 lantern glass (y unused);
                z 0 (spare)
  _grain (vec2) texture coordinates 0..1 across each wooden face, as the procedural boxes have
                them, so the wood shader runs its grain along the member.
"""

import math
import os
import random
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "furniture.glb"))

BODY, OPENING, GOODS, ROPE, IRON, GLASS = 0, 1, 2, 3, 4, 5

BUDGET = {"Jar": 160, "Amphora": 160, "Jug": 160, "Crate": 120, "Sack": 100, "Basket": 140,
          "Cart": 500, "Bench": 120, "Lantern": 120}


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


def norm(a):
    l = math.sqrt(dot(a, a)) or 1.0
    return (a[0] / l, a[1] / l, a[2] / l)


def lerp(a, b, t):
    return add(a, mul(sub(b, a), t))


class Mesh:
    def __init__(self):
        self.pos = []
        self.info = []
        self.uv = []
        self.tri = []

    def v(self, p, part, tint=0.0, uv=(0.5, 0.5)):
        self.pos.append(tuple(p))
        self.info.append((float(part), float(tint), 0.0))
        self.uv.append(uv)
        return len(self.pos) - 1

    def t(self, a, b, c, hint):
        """A triangle wound so its face normal agrees with hint (a direction)."""
        pa, pb, pc = self.pos[a], self.pos[b], self.pos[c]
        if dot(cross(sub(pb, pa), sub(pc, pa)), hint) < 0:
            b, c = c, b
        self.tri.append((a, b, c))

    def tc(self, a, b, c, centre, outward=True):
        """A triangle facing away from (or, outward False, toward) a centre point."""
        m = mul(add(add(self.pos[a], self.pos[b]), self.pos[c]), 1 / 3)
        h = sub(m, centre)
        self.t(a, b, c, h if outward else mul(h, -1))

    def q(self, a, b, c, d, hint):
        self.t(a, b, c, hint)
        self.t(a, c, d, hint)

    def face(self, pts, part, tint, hint, uvs=None):
        """A flat convex polygon of its own vertices (a hard edge all round)."""
        if uvs is None:
            uvs = [(0, 0), (1, 0), (1, 1), (0, 1)] if len(pts) == 4 else [(0.5, 0.5)] * len(pts)
        ids = [self.v(p, part, tint, uv) for p, uv in zip(pts, uvs)]
        for k in range(1, len(ids) - 1):
            self.t(ids[0], ids[k], ids[k + 1], hint)

    def obox(self, c, ax, ay, az, hx, hy, hz, part, tint, skip=()):
        """A box about c with unit axes ax, ay, az and half sizes; skip lists faces to leave out
        ('+x', '-x', '+y', '-y', '+z', '-z')."""
        def P(sx, sy, sz):
            return add(add(add(c, mul(ax, sx * hx)), mul(ay, sy * hy)), mul(az, sz * hz))
        faces = {
            "+x": ([P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1)], ax),
            "-x": ([P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1)], mul(ax, -1)),
            "+y": ([P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)], ay),
            "-y": ([P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1)], mul(ay, -1)),
            "+z": ([P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], az),
            "-z": ([P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], mul(az, -1)),
        }
        for k, (pts, n) in faces.items():
            if k not in skip:
                self.face(pts, part, tint, n)

    def box(self, x0, y0, z0, x1, y1, z1, part, tint, skip=()):
        self.obox(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (1, 0, 0), (0, 1, 0), (0, 0, 1),
                  (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, part, tint, skip)

    def tris(self):
        return len(self.tri)


# ---------------------------------------------------------------- turned shapes


class Ring:
    """One ring of a turned shape: radius r at height y. brk starts a new strip here (a hard edge
    or a change of part); off turns the ring by a fraction of a side (the weave); jit(a) scales
    the radius at angle a; dy(a) lifts it; cx, cz shift its centre."""

    def __init__(self, r, y, part=BODY, tint=0.0, brk=False, off=0.0, jit=None, dy=None, cx=0.0, cz=0.0, inward=False):
        self.r, self.y, self.part, self.tint, self.brk, self.off = r, y, part, tint, brk, off
        self.jit, self.dy, self.cx, self.cz, self.inward = jit, dy, cx, cz, inward


def lathe(m, rings, sides, rot=0.0, cap=None):
    """Bands between consecutive rings (a new strip where a ring has brk). cap: None leaves the
    top open, or (y, part, tint, up) fans the last ring to a centre point at height y."""
    prev = None
    prev_ring = None
    for R in rings:
        ids = []
        for i in range(sides):
            a = rot + (i + R.off) / sides * TAU
            rr = R.r * (R.jit(a) if R.jit else 1.0)
            yy = R.y + (R.dy(a) if R.dy else 0.0)
            ids.append(m.v((R.cx + math.cos(a) * rr, yy, R.cz + math.sin(a) * rr), R.part, R.tint,
                           ((i + R.off) / sides % 1.0, min(1.0, max(0.0, R.y)))))
        if prev is not None and not R.brk:
            for i in range(sides):
                j = (i + 1) % sides
                # outward: away from the axis, at the height of the band
                ca = (prev_ring.cx + R.cx) / 2, (prev_ring.cz + R.cz) / 2
                for tri in ((prev[i], prev[j], ids[j]), (prev[i], ids[j], ids[i])):
                    pm = mul(add(add(m.pos[tri[0]], m.pos[tri[1]]), m.pos[tri[2]]), 1 / 3)
                    h = (pm[0] - ca[0], 0.0, pm[2] - ca[1])
                    # a band that turns over (a lip top) faces up or down rather than out
                    dr = R.r - prev_ring.r
                    dyy = R.y - prev_ring.y
                    if abs(dyy) < 1e-6:
                        h = (0, 1 if dr < 0 else -1, 0)
                    if R.inward:
                        h = mul(h, -1)
                    m.t(*tri, h)
        prev, prev_ring = ids, R
    if cap is not None:
        y, part, tint, up = cap
        R = prev_ring
        ids = []
        for i in range(sides):
            a = rot + (i + R.off) / sides * TAU
            rr = R.r * (R.jit(a) if R.jit else 1.0)
            yy = R.y + (R.dy(a) if R.dy else 0.0)
            ids.append(m.v((R.cx + math.cos(a) * rr, yy, R.cz + math.sin(a) * rr), part, tint))
        c = m.v((R.cx, y, R.cz), part, tint)
        for i in range(sides):
            m.t(ids[i], ids[(i + 1) % sides], c, (0, 1 if up else -1, 0))


def tube(m, pts, r, sides, part, tint, rot=0.0):
    """A tube through pts (no caps), each ring square to the path."""
    n = len(pts)
    rings = []
    for k in range(n):
        d = norm(sub(pts[min(n - 1, k + 1)], pts[max(0, k - 1)]))
        e = norm(cross(d, (0, 1, 0))) if abs(d[1]) < 0.95 else norm(cross(d, (1, 0, 0)))
        f = cross(d, e)
        ring = []
        for i in range(sides):
            a = rot + i / sides * TAU
            o = add(mul(e, math.cos(a) * r), mul(f, math.sin(a) * r))
            ring.append((m.v(add(pts[k], o), part, tint, (i / sides, k / (n - 1))), pts[k]))
        rings.append(ring)
    for k in range(n - 1):
        A, B = rings[k], rings[k + 1]
        for i in range(sides):
            j = (i + 1) % sides
            c = lerp(A[i][1], B[i][1], 0.5)
            m.tc(A[i][0], A[j][0], B[j][0], c)
            m.tc(A[i][0], B[j][0], B[i][0], c)


def arc(c, u, w, r, a0, a1, n):
    """Points on a circular arc about c in the plane of unit vectors u and w."""
    return [add(c, add(mul(u, math.cos(a) * r), mul(w, math.sin(a) * r)))
            for a in (a0 + (a1 - a0) * k / (n - 1) for k in range(n))]


# ---------------------------------------------------------------- jars


def jar(variant):
    """Kind 0: the round water jar, height 1. 0 plain, 1 a rope round the shoulder, 2 squat
    with a wide mouth and two lugs."""
    m = Mesh()
    if variant == 2:
        sides = 8
        R = [Ring(0.21, 0.0, tint=-0.06), Ring(0.32, 0.09), Ring(0.37, 0.3), Ring(0.35, 0.52),
             Ring(0.27, 0.72), Ring(0.215, 0.82), Ring(0.24, 0.87), Ring(0.235, 0.93),
             Ring(0.19, 0.93), Ring(0.18, 0.89, inward=True)]
        lathe(m, R, sides, rot=0.2, cap=(0.86, OPENING, 0.5, True))
        # two lugs on the shoulder: little wedges
        for s in (0, math.pi):
            ca, sa = math.cos(s), math.sin(s)
            base = [(ca * 0.33 - sa * dz, y, sa * 0.33 + ca * dz) for dz, y in ((-0.05, 0.56), (0.05, 0.56), (0.0, 0.66))]
            tip = (ca * 0.4, 0.6, sa * 0.4)
            ids = [m.v(p, BODY, -0.04) for p in base]
            t = m.v(tip, BODY, 0.04)
            c = (ca * 0.3, 0.6, sa * 0.3)
            for i in range(3):
                m.tc(ids[i], ids[(i + 1) % 3], t, c)
        return m
    if variant == 1:
        sides = 7
        R = [Ring(0.2, 0.0, tint=-0.06), Ring(0.3, 0.1), Ring(0.37, 0.34), Ring(0.335, 0.57),
             Ring(0.285, 0.68),
             Ring(0.285, 0.68, ROPE, 0.78, brk=True), Ring(0.305, 0.705, ROPE, 0.86, off=0.5),
             Ring(0.27, 0.735, ROPE, 0.78),
             Ring(0.27, 0.735, brk=True), Ring(0.15, 0.87), Ring(0.2, 0.95), Ring(0.185, 1.0),
             Ring(0.14, 0.99, inward=True)]
        lathe(m, R, sides, rot=0.4, cap=(0.95, OPENING, 0.5, True))
        return m
    sides = 8
    R = [Ring(0.2, 0.0, tint=-0.06), Ring(0.3, 0.1), Ring(0.37, 0.34), Ring(0.335, 0.58),
         Ring(0.22, 0.8), Ring(0.15, 0.88), Ring(0.2, 0.95), Ring(0.185, 1.0),
         Ring(0.14, 0.99, inward=True)]
    lathe(m, R, sides, cap=(0.95, OPENING, 0.5, True))
    return m


def loop_handle(m, x_neck, y_neck, x_sh, y_sh, out, r, sides, side):
    """A loop handle in the x/y plane on side (+1/-1) from the neck out and down to the shoulder."""
    s = side
    p0 = (s * x_neck, y_neck, 0)
    p1 = (s * (x_neck + out * 0.8), y_neck + 0.01, 0)
    p2 = (s * (x_sh + out * 0.35), (y_neck + y_sh) / 2 + 0.03, 0)
    p3 = (s * x_sh, y_sh, 0)
    tube(m, [p0, p1, p2, p3], r, sides, BODY, -0.03)


def amphora(variant):
    m = Mesh()
    sides = 7
    if variant == 0:
        R = [Ring(0.065, 0.0, tint=-0.06), Ring(0.16, 0.14), Ring(0.235, 0.38), Ring(0.235, 0.58),
             Ring(0.15, 0.76), Ring(0.085, 0.87), Ring(0.11, 0.98), Ring(0.1, 1.02),
             Ring(0.07, 1.01, inward=True)]
        lathe(m, R, sides, rot=TAU / 28, cap=(0.97, OPENING, 0.5, True))
        for s in (1, -1):
            loop_handle(m, 0.08, 0.9, 0.19, 0.69, 0.13, 0.022, 3, s)
    else:
        # a slimmer, taller-necked one with a ridge at the shoulder
        R = [Ring(0.07, 0.0, tint=-0.06), Ring(0.18, 0.16), Ring(0.24, 0.44), Ring(0.2, 0.64),
             Ring(0.2, 0.64, brk=True, tint=0.05), Ring(0.12, 0.74, tint=0.05), Ring(0.075, 0.8),
             Ring(0.07, 0.96), Ring(0.1, 1.02), Ring(0.065, 1.01, inward=True)]
        lathe(m, R, sides, rot=TAU / 28, cap=(0.97, OPENING, 0.5, True))
        for s in (1, -1):
            loop_handle(m, 0.07, 0.93, 0.16, 0.7, 0.14, 0.02, 3, s)
    return m


def jug(variant):
    m = Mesh()
    sides = 7
    R = [Ring(0.15, 0.0, tint=-0.06), Ring(0.23, 0.16), Ring(0.25, 0.36), Ring(0.17, 0.58),
         Ring(0.095, 0.72), Ring(0.13, 0.8), Ring(0.12, 0.84), Ring(0.09, 0.83, inward=True)]
    lathe(m, R, sides, cap=(0.79, OPENING, 0.5, True))
    if variant == 1:
        loop_handle(m, 0.1, 0.74, 0.22, 0.4, 0.14, 0.022, 3, 1)
    return m


# ---------------------------------------------------------------- sacks


def sack(variant):
    """Unit radius and height: a full sack slumped under its own weight, lopsided, a crease
    pressed in at a slant, the neck gathered and tied, the mouth's corners sticking up."""
    rng = random.Random(500 + variant)
    sides = 7
    ph = [rng.uniform(0, TAU) for _ in range(4)]
    flat = [0.22, 0.3, 0.16][variant]  # one side pressed flat (against the wall or a neighbour)

    def jit(k, amt=1.0):
        def f(a):
            j = 1 + amt * (0.09 * math.sin(2 * a + ph[0] + k) + 0.06 * math.sin(3 * a + ph[1] - 2 * k))
            return j * (1 - flat * max(0.0, math.cos(a - ph[2])) ** 3)
        return f

    lean = [0.1, 0.2, -0.14][variant]
    lx, lz = math.cos(ph[3]) * lean, math.sin(ph[3]) * lean
    crease = lambda a: 0.1 * math.sin(a + ph[1]) - 0.02  # the crease runs round at a slant
    top = [1.0, 0.94, 0.86][variant]
    R = [Ring(0.9, 0.0, tint=-0.06, jit=jit(0, 0.5)),
         Ring(1.0, 0.22, jit=jit(1)),
         Ring(0.88, 0.47, jit=jit(2), dy=crease, cx=lx * 0.35, cz=lz * 0.35, tint=-0.04),
         Ring(0.74, 0.66 * top, jit=jit(3), cx=lx * 0.65, cz=lz * 0.65),
         Ring(0.25, 0.86 * top, cx=lx, cz=lz, tint=-0.05),
         Ring(0.25, 0.86 * top, ROPE, 0.8, brk=True, cx=lx, cz=lz),
         Ring(0.23, 0.92 * top, ROPE, 0.86, cx=lx, cz=lz),
         Ring(0.23, 0.92 * top, brk=True, cx=lx, cz=lz),
         Ring(0.46, 1.0 * top, jit=jit(4, 1.6), dy=lambda a: 0.07 * math.sin(2 * a + ph[0]), cx=lx * 1.15, cz=lz * 1.15)]
    m = Mesh()
    lathe(m, R, sides, rot=ph[0], cap=(0.93 * top, BODY, -0.14, True))
    return m


# ---------------------------------------------------------------- baskets


def basket(variant):
    """Rim radius 1 at y 0.62. Woven body (rings turned half a side in turn), a rolled rim;
    0 heaped with goods, 1 with two rope handles, 2 with a lid."""
    m = Mesh()
    sides = 8
    body = [Ring(0.72, 0.0, tint=-0.08), Ring(0.8, 0.17, off=0.5), Ring(0.88, 0.34, tint=0.03),
            Ring(0.95, 0.5, off=0.5),
            Ring(1.03, 0.565, tint=-0.04), Ring(1.0, 0.63, tint=-0.04, off=0.5),
            Ring(0.91, 0.6, tint=-0.08, inward=True)]
    if variant == 2:
        rings = body + [Ring(1.0, 0.64, tint=0.04, brk=True), Ring(0.62, 0.75, tint=0.0, off=0.5),
                        Ring(0.14, 0.81, tint=-0.06)]
        lathe(m, rings, sides, cap=(0.88, BODY, -0.06, True))
        return m
    rings = body + [Ring(0.91, 0.6, GOODS, 0.0, brk=True)]
    if variant == 0:
        rings += [Ring(0.55, 0.7, GOODS, 0.03, off=0.5)]
        lathe(m, rings, sides, cap=(0.76, GOODS, 0.05, True))
    else:
        lathe(m, rings, sides, cap=(0.66, GOODS, 0.03, True))
        for s in (1, -1):
            pts = arc((s * 0.98, 0.6, 0), (0, 0, 1), (0, 1, 0), 0.17, 0.15, math.pi - 0.15, 4)
            tube(m, pts, 0.035, 3, ROPE, 0.8)
    return m


# ---------------------------------------------------------------- crates

HU, HN, HH = 0.29, 0.25, 0.42


def crate(open_, variant):
    """Half sizes HU along x, HN along z, height HH. Corner posts, slats proud of a darker core."""
    m = Mesh()
    T = 0.016  # how far the slats and posts stand proud of the core
    P = 0.032  # post half width
    yt = HH
    gap = -0.13  # the core shows between the slats, darker
    # core: the walls behind the slats
    cx, cz = HU - T, HN - T
    m.box(-cx, 0, -cz, cx, yt - (0.0 if open_ else 0.012), cz, BODY, gap, skip=("-y",) + (("+y",) if open_ else ()))
    # corner posts: their two outer faces and the top
    for sx in (1, -1):
        for sz in (1, -1):
            x0, x1 = sorted((sx * (HU - 2 * P), sx * HU))
            z0, z1 = sorted((sz * (HN - 2 * P), sz * HN))
            skip = ["-y", "-x" if sx > 0 else "+x", "-z" if sz > 0 else "+z"]
            m.box(x0, 0, z0, x1, yt + (0.006 if not open_ else 0.0), z1, BODY, -0.07, skip=skip)
    # slats: boards between the posts, outer face and the two edges
    rows_long = [3, 2][variant] if not open_ else [2, 3][variant]
    rows_short = [3, 2][variant] if not open_ else 2
    for axis, half, span, rows in (("x", HU, HN, rows_short), ("z", HN, HU, rows_long)):
        g = 0.026
        hgt = (yt - (rows + 1) * g) / rows
        for s in (1, -1):
            for k in range(rows):
                y0 = g * 0.6 + k * (hgt + g)
                y1 = y0 + hgt
                if k == rows - 1:
                    y1 = yt - 0.004
                tint = 0.04 * ((k * 7 + (s > 0) * 3) % 3 - 1)
                a0, a1 = -(span - 2 * P), span - 2 * P
                if axis == "x":
                    x0, x1 = sorted((s * (HU - T), s * HU))
                    m.box(x0, y0, a0, x1, y1, a1, BODY, tint, skip=("-x" if s > 0 else "+x", "-z", "+z"))
                else:
                    z0, z1 = sorted((s * (HN - T), s * HN))
                    m.box(a0, y0, z0, a1, y1, z1, BODY, tint, skip=("-z" if s > 0 else "+z", "-x", "+x"))
    if not open_ and variant == 1:
        # diagonal braces on the long sides
        for s in (1, -1):
            L = math.hypot(2 * (HU - 2 * P), yt - 0.06)
            ang = math.atan2(yt - 0.06, 2 * (HU - 2 * P)) * s
            ax = (math.cos(ang), math.sin(ang), 0)
            ay = (-math.sin(ang), math.cos(ang), 0)
            c = (0, yt / 2, s * (HN + T * 0.5))
            m.obox(c, ax, ay, (0, 0, 1), L / 2 - 0.02, 0.028, T * 0.5, BODY, 0.06,
                   skip=("-x", "+x", "-z" if s > 0 else "+z"))
    if not open_:
        # the lid: planks along x, a hair apart, and on variant 1 two battens across
        n = 3
        w = (2 * HN - 2 * P) / n
        for k in range(n):
            z0 = -HN + P + k * w + 0.005
            z1 = z0 + w - 0.01
            m.face([(-(HU - 2 * P), yt, z0), (HU - 2 * P, yt, z0), (HU - 2 * P, yt, z1), (-(HU - 2 * P), yt, z1)],
                   BODY, 0.05 * (k - 1), (0, 1, 0))
        if variant == 1:
            for sx in (1, -1):
                xc = sx * (HU - 2 * P - 0.05)
                m.box(xc - 0.03, yt, -(HN - 2 * P), xc + 0.03, yt + 0.022, HN - 2 * P, BODY, -0.04, skip=("-y",))
        return m
    # open: the inner walls down to the goods, the rim, the goods heaped up
    ix, iz = HU - 0.03, HN - 0.03
    yg = HH * 0.84
    m.box(-ix, yg, -iz, ix, yt, iz, BODY, -0.18, skip=("+y", "-y"))  # faces turned in below
    # (the box above faces out; turn its four walls to face inward)
    for k in range(len(m.tri) - 8, len(m.tri)):
        a, b, c = m.tri[k]
        m.tri[k] = (a, c, b)
    # rim tops between the inner walls and the outside
    for sx in (1, -1):
        x0, x1 = sorted((sx * ix, sx * (HU - T)))
        m.face([(x0, yt, -(HN - T)), (x1, yt, -(HN - T)), (x1, yt, HN - T), (x0, yt, HN - T)], BODY, 0.06, (0, 1, 0))
    for sz in (1, -1):
        z0, z1 = sorted((sz * iz, sz * (HN - T)))
        m.face([(-ix, yt, z0), (ix, yt, z0), (ix, yt, z1), (-ix, yt, z1)], BODY, 0.06, (0, 1, 0))
    # goods: a 3 x 3 heap, highest a little off centre
    hump = min(ix, iz) * 0.55
    ids = {}
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            h = yg + (hump if (i, j) == (0, 0) else hump * 0.45 if i == 0 or j == 0 else 0.0)
            ids[(i, j)] = m.v((i * ix * (0.96 if i else 1) + (0.03 if (i, j) == (0, 0) else 0), h, j * iz),
                              GOODS, 0.03 * (i - j))
    for i in (-1, 0):
        for j in (-1, 0):
            a, b, c, d = ids[(i, j)], ids[(i + 1, j)], ids[(i + 1, j + 1)], ids[(i, j + 1)]
            m.q(a, b, c, d, (0, 1, 0))
    return m


# ---------------------------------------------------------------- benches


def bench(legs):
    """Seat half length 0.7 (two legs) or 1.05 (three) along x, half depth 0.2, top at 0.45."""
    m = Mesh()
    hl = 0.7 if legs == 2 else 1.05
    # two seat planks with a narrow gap
    for k, (z0, z1) in enumerate(((-0.2, -0.006), (0.006, 0.2))):
        skip = ["-y", "+z" if k == 0 else "-z"]
        m.box(-hl, 0.38, z0, hl, 0.45, z1, BODY, 0.04 * (k * 2 - 1), skip=skip)
    # slab legs with a notch cut from the foot
    outline = [(-0.16, -0.02), (-0.065, -0.02), (-0.04, 0.09), (0.04, 0.09), (0.065, -0.02), (0.16, -0.02),
               (0.15, 0.38), (-0.15, 0.38)]
    tris = [(0, 1, 7), (1, 2, 7), (2, 6, 7), (2, 3, 6), (3, 4, 6), (4, 5, 6)]
    xs = [-hl + 0.14, hl - 0.14] if legs == 2 else [-hl + 0.14, 0.0, hl - 0.14]
    for xi, xc in enumerate(xs):
        t = 0.04
        for s in (1, -1):
            ids = [m.v((xc + s * t, y, z), BODY, -0.06, (0.5 + z, y)) for z, y in outline]
            for a, b, c in tris:
                m.t(ids[a], ids[b], ids[c], (s, 0, 0))
        n = len(outline)
        for i in range(n):
            j = (i + 1) % n
            (za, ya), (zb, yb) = outline[i], outline[j]
            if (ya < 0 and yb < 0) or (ya > 0.37 and yb > 0.37):
                continue  # on the ground, or under the seat
            pts = [(xc - t, ya, za), (xc + t, ya, za), (xc + t, yb, zb), (xc - t, yb, zb)]
            # the outline runs counter-clockwise in (z, y): its outward normal is (dy, -dz)
            m.face(pts, BODY, -0.1, (0, -(zb - za), yb - ya))
    # a stretcher low between the legs, on the long bench a batten under the seat at each end
    m.box(xs[0], 0.15, -0.025, xs[-1], 0.21, 0.025, BODY, -0.1, skip=("-x", "+x"))
    if legs == 2:
        for xc in xs:
            m.box(xc - 0.05, 0.34, -0.19, xc + 0.05, 0.38, 0.19, BODY, -0.12, skip=("+y",))
    return m


# ---------------------------------------------------------------- handcarts


def wheel(m, zc, zw, ya, r, spokes, segs, tint, rot):
    """A spoked wheel in the x/y plane at z zc (width zw), axle height ya."""
    tr = 0.055  # rim depth
    out = (0, 0, 1 if zc > 0 else -1)
    z0, z1 = zc - zw / 2, zc + zw / 2
    def P(a, rr, z):
        return (math.cos(a) * rr, ya + math.sin(a) * rr, z)
    rings = []
    for k in range(segs):
        a = rot + k / segs * TAU
        rings.append(a)
    for k in range(segs):
        a, b = rings[k], rings[(k + 1) % segs]
        mid = (a + b) / 2
        radial = (math.cos(mid), math.sin(mid), 0)
        # iron tyre: the tread
        m.face([P(a, r, z0), P(b, r, z0), P(b, r, z1), P(a, r, z1)], IRON, 0.12, radial)
        # wooden felloe: inside, and the two side faces
        ri = r - tr
        m.face([P(a, ri, z0), P(a, ri, z1), P(b, ri, z1), P(b, ri, z0)], BODY, tint, mul(radial, -1))
        m.face([P(a, ri, z1), P(a, r, z1), P(b, r, z1), P(b, ri, z1)], BODY, tint + 0.04, (0, 0, 1))
        m.face([P(a, ri, z0), P(b, ri, z0), P(b, r, z0), P(a, r, z0)], BODY, tint + 0.04, (0, 0, -1))
    # spokes: thin boxes from the hub to the felloe
    for k in range(spokes):
        a = rot + (k + 0.5) / spokes * TAU
        d = (math.cos(a), math.sin(a), 0)
        e = (-math.sin(a), math.cos(a), 0)
        c = (d[0] * (r - tr + 0.07) / 2, ya + d[1] * (r - tr + 0.07) / 2, zc)
        m.obox(c, d, e, (0, 0, 1), (r - tr - 0.07) / 2, 0.018, 0.016, BODY, tint + 0.02, skip=("+x", "-x"))
    # hub: a short hexagonal drum, iron capped
    hs = 6
    hr = 0.075
    ids_o, ids_i = [], []
    for k in range(hs):
        a = k / hs * TAU
        ids_o.append(m.v(P(a, hr, zc + out[2] * 0.06), BODY, tint - 0.05))
        ids_i.append(m.v(P(a, hr, zc - out[2] * 0.06), BODY, tint - 0.05))
    for k in range(hs):
        j = (k + 1) % hs
        m.tc(ids_o[k], ids_o[j], ids_i[j], (0, ya, zc))
        m.tc(ids_o[k], ids_i[j], ids_i[k], (0, ya, zc))
    cap = [m.v(P(k / hs * TAU, hr, zc + out[2] * 0.06), IRON, 0.12) for k in range(hs)]
    cc = m.v((0, ya, zc + out[2] * 0.09), IRON, 0.18)
    for k in range(hs):
        m.t(cap[k], cap[(k + 1) % hs], cc, out)


def cart(variant):
    """Bed along x in [-0.65, 0.65], 0.84 wide, top at 0.57; wheels at z +-0.5, axle at 0.42;
    shafts from the bed down to the ground at x 1.8."""
    m = Mesh()
    yb = 0.5
    # bed: three planks along x
    for k in range(3):
        z0 = -0.42 + k * 0.28 + 0.004
        z1 = z0 + 0.28 - 0.008
        skip = ["-y"] + (["-z"] if k > 0 else []) + (["+z"] if k < 2 else [])
        m.box(-0.65, yb, z0, 0.65, yb + 0.07, z1, BODY, 0.04 * (k - 1), skip=skip)
    # bearers under the bed, across
    for xc in (-0.45, 0.45):
        m.box(xc - 0.04, yb - 0.06, -0.42, xc + 0.04, yb, 0.42, BODY, -0.12, skip=("+y",))
    ytop = yb + 0.3
    if variant == 0:
        # slatted sides: two boards a side on three stakes, a low board at each end
        for s in (1, -1):
            z0, z1 = sorted((s * 0.378, s * 0.422))
            for (y0, y1) in ((yb + 0.08, yb + 0.17), (yb + 0.2, ytop)):
                m.box(-0.65, y0, z0, 0.65, y1, z1, BODY, 0.02, skip=())
            for xc in (-0.6, 0.0, 0.6):
                sz0, sz1 = (z1, z1 + 0.025) if s > 0 else (z0 - 0.025, z0)
                m.box(xc - 0.03, yb + 0.07, sz0, xc + 0.03, ytop + 0.04, sz1, BODY, -0.1,
                      skip=("-y",) + (("-z",) if s > 0 else ("+z",)))
        for s in (1, -1):
            x0, x1 = sorted((s * 0.608, s * 0.652))
            m.box(x0, yb + 0.07, -0.378, x1, yb + 0.22, 0.378, BODY, -0.03, skip=("-y", "-z", "+z"))
    else:
        # solid plank sides, flared a little, with a rail on top
        for s in (1, -1):
            ang = s * 0.18
            ay = (0, math.cos(ang), math.sin(ang))
            c = (0, yb + 0.07 + 0.11, s * (0.4 + 0.02))
            m.obox(c, (1, 0, 0), ay, (0, -math.sin(ang), math.cos(ang)), 0.65, 0.11, 0.02, BODY, 0.0, skip=("-y",))
            m.box(-0.66, yb + 0.29, s * 0.46 - 0.03, 0.66, yb + 0.32, s * 0.46 + 0.03, BODY, -0.08, skip=("-y",))
        for s in (1, -1):
            x0, x1 = sorted((s * 0.608, s * 0.652))
            m.box(x0, yb + 0.07, -0.4, x1, yb + 0.26, 0.4, BODY, -0.03, skip=("-y", "-z", "+z"))
    # shafts: from under the bed's front down to the ground ahead, bending a little
    for s in (1, -1):
        a = (0.3, yb - 0.03, s * 0.34)
        b = (1.1, yb - 0.18, s * 0.31)
        c = (1.8, 0.05, s * 0.28)
        tube(m, [a, b, c], 0.032, 4, BODY, -0.04, rot=math.pi / 4)
    # a crossbar between the shafts
    m.box(1.05, yb - 0.2, -0.31, 1.11, yb - 0.15, 0.31, BODY, -0.1, skip=("-z", "+z"))
    # axle and wheels
    m.box(-0.035, 0.385, -0.47, 0.035, 0.455, 0.47, BODY, -0.2, skip=("-z", "+z"))
    for s in (1, -1):
        wheel(m, s * 0.505, 0.07, 0.42, 0.42, 6 if variant == 0 else 5, 10, -0.14, 0.13 if s > 0 else 0.41)
    return m


# ---------------------------------------------------------------- lanterns


def lantern(variant):
    """Hangs from its hook at (0, 0, 0): a pierced cap, glass panes in a metal frame, a pierced
    foot. 0 hexagonal with a pointed roof, 1 square with a stepped one."""
    m = Mesh()
    n = 6 if variant == 0 else 4
    rot = 0.0 if variant == 0 else math.pi / 4
    rg = 0.11 if variant == 0 else 0.125  # glass
    re = 0.16 if variant == 0 else 0.165  # eave

    def pt(k, r, y):
        a = rot + k / n * TAU
        return (math.cos(a) * r, y, math.sin(a) * r)

    # the roof
    if variant == 0:
        apex = m.v((0, 0, 0), IRON, 0.1)
        ring = [m.v(pt(k, re, -0.09), IRON, 0.14) for k in range(n)]
        for k in range(n):
            m.tc(ring[k], ring[(k + 1) % n], apex, (0, -0.2, 0))
    else:
        apex = m.v((0, 0, 0), IRON, 0.1)
        mid = [m.v(pt(k, 0.07, -0.035), IRON, 0.12) for k in range(n)]
        for k in range(n):
            m.tc(mid[k], mid[(k + 1) % n], apex, (0, -0.2, 0))
        mid2 = [m.v(pt(k, 0.07, -0.035), IRON, 0.12) for k in range(n)]
        ring2 = [m.v(pt(k, 0.07, -0.06), IRON, 0.12) for k in range(n)]
        for k in range(n):
            j = (k + 1) % n
            m.q(mid2[k], mid2[j], ring2[j], ring2[k], sub(pt(k + 0.5, 1, 0), (0, 0, 0)))
        ring = [m.v(pt(k, re, -0.09), IRON, 0.14) for k in range(n)]
        r2 = [m.v(pt(k, 0.07, -0.06), IRON, 0.12) for k in range(n)]
        for k in range(n):
            j = (k + 1) % n
            m.q(r2[k], r2[j], ring[j], ring[k], (0, 1, 0))

    # pierced bands: on each side a glass diamond cut through a metal plate
    def pierced(y0, y1, r):
        for k in range(n):
            a, b = pt(k, r, y0), pt(k + 1, r, y0)
            c, d = pt(k + 1, r, y1), pt(k, r, y1)
            out = sub(pt(k + 0.5, 1, 0), (0, 0, 0))
            eb, er, et, el = lerp(a, b, 0.5), lerp(b, c, 0.5), lerp(c, d, 0.5), lerp(d, a, 0.5)
            m.face([eb, er, et, el], GLASS, 0, out, uvs=[(0.5, 0.5)] * 4)
            for tri in ((a, eb, el), (eb, b, er), (er, c, et), (et, d, el)):
                m.face(list(tri), IRON, 0.12, out)

    pierced(-0.09, -0.15, rg + 0.01)
    # glass panes
    for k in range(n):
        out = sub(pt(k + 0.5, 1, 0), (0, 0, 0))
        m.face([pt(k, rg, -0.15), pt(k + 1, rg, -0.15), pt(k + 1, rg, -0.32), pt(k, rg, -0.32)], GLASS, 0, out)
    # straps down the corners, lying on the panes either side
    for k in range(n):
        c0, c1 = pt(k, rg + 0.006, -0.15), pt(k, rg + 0.006, -0.32)
        for s in (1, -1):
            e = lerp(pt(k, rg + 0.006, 0), pt(k + s, rg + 0.006, 0), 0.16)
            e0, e1 = (e[0], -0.15, e[2]), (e[0], -0.32, e[2])
            m.face([c0, e0, e1, c1], IRON, 0.08, sub(pt(k + 0.5 * s, 1, 0), (0, 0, 0)))
    if variant == 1:
        pierced(-0.32, -0.37, rg + 0.01)
    else:
        for k in range(n):
            out = sub(pt(k + 0.5, 1, 0), (0, 0, 0))
            m.face([pt(k, rg + 0.01, -0.32), pt(k + 1, rg + 0.01, -0.32), pt(k + 1, rg + 0.016, -0.36), pt(k, rg + 0.016, -0.36)], IRON, 0.1, out)
    # the foot: a shallow tray and a little drop finial
    yf = -0.36 if variant == 0 else -0.37
    tr = [m.v(pt(k, rg + (0.016 if variant == 0 else 0.01), yf), IRON, 0.08) for k in range(n)]
    lo = [m.v(pt(k, rg - 0.045, -0.39), IRON, 0.06) for k in range(n)]
    for k in range(n):
        j = (k + 1) % n
        m.q(tr[k], tr[j], lo[j], lo[k], add(sub(pt(k + 0.5, 1, 0), (0, 0, 0)), (0, -0.6, 0)))
    tip = m.v((0, -0.43, 0), IRON, 0.04)
    for k in range(n):
        m.tc(lo[k], lo[(k + 1) % n], tip, (0, -0.3, 0))
    return m


# ---------------------------------------------------------------- the set


def models():
    out = {}
    for i in range(3):
        out[f"Jar{i}"] = jar(i)
    for i in range(2):
        out[f"Amphora{i}"] = amphora(i)
        out[f"Jug{i}"] = jug(i)
    for i in range(3):
        out[f"Sack{i}"] = sack(i)
        out[f"Basket{i}"] = basket(i)
    for i in range(2):
        out[f"CrateShut{i}"] = crate(False, i)
        out[f"CrateOpen{i}"] = crate(True, i)
    out["Bench0"] = bench(2)
    out["Bench1"] = bench(3)
    for i in range(2):
        out[f"Cart{i}"] = cart(i)
        out[f"Lantern{i}"] = lantern(i)
    return out


def budget(name):
    for k, v in BUDGET.items():
        if name.startswith(k):
            return v
    return 1 << 30


def outward_share(m):
    """Share of triangles whose face normal points away from the mesh's centre (a winding check)."""
    c = [sum(p[i] for p in m.pos) / len(m.pos) for i in range(3)]
    good = 0
    for a, b, cc in m.tri:
        pa, pb, pc = m.pos[a], m.pos[b], m.pos[cc]
        n = cross(sub(pb, pa), sub(pc, pa))
        mid = mul(add(add(pa, pb), pc), 1 / 3)
        if dot(n, sub(mid, c)) >= 0:
            good += 1
    return good / max(1, len(m.tri))


# ---------------------------------------------------------------- Blender side


def to_blender(p):
    return (p[0], -p[2], p[1])


def make_mesh(name, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in m.pos], [], m.tri)
    me.validate(clean_customdata=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export(ms):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, m in ms.items():
        ob = make_mesh(name, m)
        me = ob.data
        a = me.attributes.new("_info", "FLOAT_VECTOR", "POINT")
        a.data.foreach_set("vector", [c for t in m.info for c in t])
        g = me.attributes.new("_grain", "FLOAT2", "POINT")
        g.data.foreach_set("vector", [c for t in m.uv for c in t])
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


# ---------------------------------------------------------------- previews


def colour(name, info):
    part, tint, _ = info
    if part == OPENING:
        return (0.06, 0.04, 0.03)
    if part == GLASS:
        return (1.0, 0.72, 0.36)
    if part == IRON:
        k = 0.2 + tint
        return (0.25 * k * 2, 0.23 * k * 2, 0.22 * k * 2)
    if part == ROPE:
        k = 0.7 + 0.4 * tint
        return (0.62 * k, 0.5 * k, 0.34 * k)
    if part == GOODS:
        return (0.85 + tint, 0.55 + tint, 0.22)
    k = 1 + tint * 2
    if name.startswith(("Jar", "Amphora", "Jug")):
        return (0.72 * k, 0.38 * k, 0.24 * k)  # terracotta
    if name.startswith("Sack"):
        return (0.86 * k, 0.8 * k, 0.66 * k)
    if name.startswith("Basket"):
        return (0.72 * k, 0.58 * k, 0.38 * k)
    return (0.5 * k, 0.36 * k, 0.25 * k)  # wood


def preview(ms, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.8, 0.72, 0.6, 1)
    bg.inputs[1].default_value = 0.6
    sc.world = world

    mat = bpy.data.materials.new("col")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.95
    mat.use_backface_culling = True  # a face wound the wrong way shows as a hole
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    sand = bpy.data.materials.new("sand")
    sand.use_nodes = True
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.78, 0.64, 0.46, 1)
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.active_object.data.materials.append(sand)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam
    placed = []

    def place(name, x, y=0.0, z=0.0, rot=0.0, s=(1, 1, 1)):
        m = ms[name]
        ob = make_mesh(name + "_p", m)
        ob.location = (x, -z, y)
        ob.rotation_euler = (0, 0, rot)
        ob.scale = (s[0], s[2], s[1])
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for t in m.info for c in (*colour(name, t), 1.0)])
        ob.data.materials.append(mat)
        for p in ob.data.polygons:
            p.use_smooth = False
        placed.append(ob)
        return ob

    def shoot(path, w, cz, elev=14, dist=40, yaw=0.0):
        cam.data.ortho_scale = w
        e = math.radians(elev)
        cam.location = (dist * math.cos(e) * math.sin(yaw), -dist * math.cos(e) * math.cos(yaw), cz + dist * math.sin(e))
        cam.rotation_euler = (math.radians(90 - elev), 0, yaw)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    def clear():
        for ob in placed:
            bpy.data.objects.remove(ob)
        placed.clear()

    # jars at their typical sizes (s 0.8, amphora 0.9, jug 0.42)
    row = [("Jar0", 0.8), ("Jar1", 0.8), ("Jar2", 0.75), ("Amphora0", 0.9), ("Amphora1", 0.9), ("Jug0", 0.42), ("Jug1", 0.42)]
    for i, (n, s) in enumerate(row):
        place(n, (i - 3) * 0.75, rot=0.3 * i, s=(s, s, s))
    shoot(os.path.join(out_dir, "jars.png"), 5.6, 0.45, elev=12)
    shoot(os.path.join(out_dir, "jars_top.png"), 5.6, 0.45, elev=50)
    clear()
    for i in range(3):
        place(f"Sack{i}", (i - 2.5) * 0.65, rot=0.7 * i, s=(0.24, 0.6, 0.24))
        place(f"Basket{i}", (i + 0.5) * 0.85, rot=0.4 * i, s=(0.31, 0.36, 0.31))
    shoot(os.path.join(out_dir, "sacks_baskets.png"), 4.6, 0.3, elev=16)
    shoot(os.path.join(out_dir, "sacks_baskets_top.png"), 4.6, 0.3, elev=55)
    clear()
    for i, n in enumerate(["CrateShut0", "CrateShut1", "CrateOpen0", "CrateOpen1"]):
        place(n, (i - 1.5) * 0.9, rot=0.35)
    place("CrateShut1", -1.35, y=HH, rot=0.35 + math.pi / 2, s=(0.9, 0.85, 0.8))
    shoot(os.path.join(out_dir, "crates.png"), 4.2, 0.4, elev=20)
    shoot(os.path.join(out_dir, "crates_top.png"), 4.2, 0.3, elev=55, yaw=0.5)
    clear()
    place("Bench0", -1.4, rot=0.2)
    place("Bench1", 1.3, rot=-0.2)
    shoot(os.path.join(out_dir, "benches.png"), 5.0, 0.3, elev=20)
    clear()
    place("Cart0", -1.3, rot=0.5)
    place("Cart1", 1.6, rot=2.4)
    shoot(os.path.join(out_dir, "carts.png"), 6.5, 0.5, elev=18)
    shoot(os.path.join(out_dir, "carts_top.png"), 6.5, 0.5, elev=50, yaw=0.8)
    clear()
    # lanterns hang high, so the low shot can look up at them from below the ground
    place("Lantern0", -0.3, y=20.0, rot=0.2)
    place("Lantern1", 0.3, y=20.0, rot=0.2)
    shoot(os.path.join(out_dir, "lanterns.png"), 1.3, 19.78, elev=8)
    shoot(os.path.join(out_dir, "lanterns_below.png"), 1.3, 19.78, elev=-25, dist=10)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ms = models()
    over = []
    for name, m in ms.items():
        b = budget(name)
        print("FURN", name, "verts", len(m.pos), "tris", m.tris(), "budget", b, "outward %.2f" % outward_share(m))
        if m.tris() > b:
            over.append(name)
    if over:
        raise SystemExit("over budget: " + ", ".join(over))
    export(ms)
    print("FURNITURE", OUT, os.path.getsize(OUT), "bytes")
    if "--preview" in argv:
        preview(ms, argv[argv.index("--preview") + 1])


main()
