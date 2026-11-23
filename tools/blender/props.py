"""The open world's and the towns' most visible props, exported to public/art/props.glb.

    blender --background --python tools/blender/props.py                   # write the .glb
    blender --background --python tools/blender/props.py -- --preview DIR  # and render each model

The shipped props.glb is written by tools/tripo/palm_convert.py, which loads this file (main() does
not run then), keeps every model below but the palms and puts Tripo's fan palm in their place; run
that, not this, to rebuild it. Running this alone writes the hand-made date palms below.

Everything is built in the game's own frame (metres, +Y up) and turned into Blender's Z-up frame
only when the mesh is made, so the exporter's +Y-up conversion gives back exactly these numbers.
No materials, no normals (the game works them out), no texture coordinates.

Palms (src/city/extra/plants.ts tree()), drawn for a reference tree of height 10 m:

  PalmTrunk      ringed trunk from y -0.45 (buried) to the frond origin; the game stretches the
                 part below y = TRUNK_TOP to its height, keeps the boot above it as is, scales the
                 radius and bends it by its lean
  PalmCrown0..2  the green crown, about the frond origin (0, 0, 0): arching fronds with leaflets
  PalmDead       drooping dead fronds under the crown, about the same origin
  PalmDates      hanging date clusters, about the same origin
  _info (vec3)   x material id (3 wood, 5 cloth, 6 plant, as cityShaders MAT), y tint 0..1 (the
                 game's tint byte / 255, before its own per-tree jitter), z sway 0..1: along the
                 trunk 0 at the root to 1 at the top; on crown, dead fronds 0 at the frond origin
                 to 1 at the tips (the game maps it to its own sway range); dates 0 (cloth reads
                 the sway byte as stripes, so it is never swayed)

Shrubs (plants.ts shrub()), unit radius, unit height, root at 0:

  Shrub0..2      thorny desert shrubs: a lumpy core, layered blades, bare twigs
  Bush0..1       round leafy bushes
  _info          as above; z 0 at the root to 1 at the top

Rocks (src/world/props.ts rock()), in the unit space of the icosphere they replace (about unit
radius, foot at y -0.45), with horizontal bedding ledges cut in:

  Boulder0..3    large rocks (<= 250 triangles)
  Stone0..2      small rocks and stones (about 80)
  _shade         a shade multiplier per vertex: darker in the bedding grooves and at the foot
"""

import math
import os
import random
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "props.glb"))

WOOD, CLOTH, PLANT = 3, 5, 6
TRUNK_TOP = 9.5  # where the reference trunk ends and the boot begins (h - 0.5)
FROND_Y = TRUNK_TOP + 0.55  # the frond origin, above the ground


# ---------------------------------------------------------------- small vector helpers


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


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


class Mesh:
    """Vertices in the game frame with one attribute tuple each, and triangles."""

    def __init__(self):
        self.pos = []
        self.attr = []
        self.tri = []

    def v(self, p, a):
        self.pos.append(tuple(p))
        self.attr.append(tuple(a))
        return len(self.pos) - 1

    def t(self, a, b, c):
        self.tri.append((a, b, c))

    def q(self, a, b, c, d):
        self.tri.append((a, b, c))
        self.tri.append((a, c, d))

    def band(self, r0, r1):
        """Two rings of equal size, wound outward (rings run counter-clockwise seen from above)."""
        n = len(r0)
        for i in range(n):
            j = (i + 1) % n
            self.q(r0[i], r1[i], r1[j], r0[j])

    def fan(self, r, c, up):
        n = len(r)
        for i in range(n):
            j = (i + 1) % n
            if up:
                self.t(r[i], c, r[j])
            else:
                self.t(r[i], r[j], c)


def ring_pts(cx, y, cz, r, n, rot, jit=None):
    out = []
    for i in range(n):
        a = rot - (i / n) * TAU  # clockwise in x/z, which is counter-clockwise seen from +y
        rr = r * (jit[i] if jit else 1.0)
        out.append((cx + math.cos(a) * rr, y, cz + math.sin(a) * rr))
    return out


# ---------------------------------------------------------------- palms


def palm_trunk():
    m = Mesh()
    S = 6
    r0 = 0.23
    rng = random.Random(7)

    def prof(y):
        # the original's flare at the foot and taper up the trunk
        t = max(0.0, y / TRUNK_TOP)
        return r0 * (mix(1.1, 0.72, t) + 0.5 * (1 - smoothstep(-0.45, 0.6, y)))

    def ring(y, r, rot, tint, jit=None):
        sway = min(1.0, max(0.0, y / TRUNK_TOP))
        return [m.v(p, (WOOD, tint, sway)) for p in ring_pts(0, y, 0, r, S, rot, jit)]

    prev = ring(-0.45, prof(-0.45), 0, 0.33)
    cur = ring(0.25, prof(0.25), 0.2, 0.36)
    m.band(prev, cur)
    prev = cur
    # leaf scars: the stubs of old fronds in a crosshatch, each level turned half a side and
    # alternately proud (pale lip) and drawn in (dark), so the faces between run in diamonds
    levels = 15
    for i in range(levels):
        y = 0.25 + (TRUNK_TOP - 0.25) * (i + 1) / levels
        rot = 0.2 + (i + 1) * (math.pi / S)
        lip = i % 2 == 0
        jit = [1 + 0.07 * (rng.random() - 0.5) for _ in range(S)]
        cur = ring(y, prof(y) * (1.0 if lip else 0.84), rot, 0.5 if lip else 0.24, jit)
        m.band(prev, cur)
        prev = cur
    # the boot: the bases of the living fronds, swelling out under the crown
    rt = prof(TRUNK_TOP)
    b = ring(TRUNK_TOP + 0.3, rt * 1.75, 1.1, 0.3)
    m.band(prev, b)
    c = ring(TRUNK_TOP + 0.65, rt * 1.3, 1.5, 0.27)
    m.band(b, c)
    tip = m.v((0, TRUNK_TOP + 0.85, 0), (WOOD, 0.27, 1.0))
    m.fan(c, tip, True)
    return m


def frond(m, a, e0, arch, L, tint, mat, rng, n_side=11, fold=0.5, width=0.5, sway_base=0.0, sway_scale=1.0, origin=(0, 0, 0), droop_tip=0.12, rachis=0, base=0.5):
    """One pinnate frond from origin: azimuth a, starting elevation e0, curling down by `arch`
    radians over its length L. Leaflets in a V either side, a bare stalk first."""
    segs = 24
    pts = []
    tans = []
    p = origin
    ds = L / segs
    for i in range(segs + 1):
        s = i / segs
        e = e0 - arch * s * s ** 0.3
        d = (math.cos(e) * math.cos(a), math.sin(e), math.cos(e) * math.sin(a))
        pts.append(p)
        tans.append(d)
        p = add(p, mul(d, ds))

    def at(s):
        f = s * segs
        i = min(segs - 1, int(f))
        t = f - i
        return add(pts[i], mul(sub(pts[i + 1], pts[i]), t)), norm(add(mul(tans[i], 1 - t), mul(tans[i + 1], t)))

    def sw(s):
        return sway_base + sway_scale * s

    side0 = norm(cross((0, 1, 0), (math.cos(a), 0, math.sin(a))))  # horizontal, across the frond
    # the bare stalk: a thin ribbon
    bare = 0.16
    st = []
    for k in range(4):
        s = bare * k / 3
        c, T = at(s)
        w = 0.06 * (1 - 0.4 * s / bare)
        st.append((m.v(sub(c, mul(side0, w)), (mat, tint * 0.85, sw(s))), m.v(add(c, mul(side0, w)), (mat, tint * 0.85, sw(s)))))
    for k in range(3):
        m.q(st[k][0], st[k + 1][0], st[k + 1][1], st[k][1])
    # the rachis on through the leaflets: a ribbon narrowing to the tip
    if rachis:
        prv = st[-1]
        for k in range(1, rachis + 1):
            s = bare + (1 - bare) * k / rachis
            c, T = at(s)
            w = 0.036 * (1 - 0.7 * k / rachis)
            cur = (m.v(sub(c, mul(side0, w)), (mat, tint * 0.8, sw(s))), m.v(add(c, mul(side0, w)), (mat, tint * 0.8, sw(s))))
            m.q(prv[0], cur[0], cur[1], prv[1])
            prv = cur
    # leaflets: one narrow triangle each, base on the rachis, tip out, forward and up into a V
    span = (1 - bare) / n_side
    for side in (-1, 1):
        for k in range(n_side):
            u = (k + 0.5) / n_side
            s = bare + span * (k + 0.5)
            c, T = at(s)
            across = norm(cross(T, (0, 1, 0)))
            if dot(across, side0) < 0:
                across = mul(across, -1)
            upn = norm(cross(across, T))
            if upn[1] < 0:
                upn = mul(upn, -1)
            ln = L * width * (0.32 + 0.68 * math.sin(math.pi * (0.12 + 0.8 * u)) ** 0.7) * (0.9 + 0.2 * rng.random())
            fl = fold * (1 + 0.3 * u)
            c0, _ = at(s - span * base)
            c1, _ = at(s + span * base)
            out = add(mul(across, side * math.cos(fl)), mul(upn, math.sin(fl)))
            tipp = add(add(c, mul(out, ln)), mul(T, ln * 0.55))
            tipp = add(tipp, (0, -ln * droop_tip * (0.3 + u), 0))
            sh = tint * (0.92 + 0.16 * rng.random())
            i0 = m.v(c0, (mat, sh, sw(s - span * base)))
            i1 = m.v(c1, (mat, sh, sw(s + span * base)))
            i2 = m.v(tipp, (mat, sh, min(1.0, sw(s) + 0.08 * sway_scale)))
            m.t(i0, i1, i2)
    # the last leaflet, straight on
    c, T = at(1 - span)
    e, _ = at(1.0)
    across = norm(cross(T, (0, 1, 0)))
    w = L * width * 0.08
    tipp = add(e, mul(T, L * width * 0.25))
    i0 = m.v(sub(c, mul(across, w)), (mat, tint, sw(1 - span)))
    i1 = m.v(add(c, mul(across, w)), (mat, tint, sw(1 - span)))
    i2 = m.v(tipp, (mat, tint, sw(1.0)))
    m.t(i0, i1, i2)


def palm_crown(seed):
    m = Mesh()
    rng = random.Random(seed)
    n = 12 + seed % 2
    a0 = rng.random() * TAU
    for k in range(n):
        a = a0 + k * 2.39996 + (rng.random() - 0.5) * 0.35  # golden angle
        f = k / (n - 1)  # 0 youngest (top) .. 1 oldest (bottom)
        e0 = mix(1.25, -0.05, f) + (rng.random() - 0.5) * 0.15
        arch = mix(0.85, 1.35, f) + rng.random() * 0.25
        L = mix(2.9, 3.6, min(1.0, f * 1.6)) * (0.92 + 0.14 * rng.random())
        tint = mix(0.88, 0.36, f) + (rng.random() - 0.5) * 0.08
        oy = mix(0.25, -0.15, f)
        frond(m, a, e0, arch, L, tint, PLANT, rng, n_side=10, fold=mix(0.62, 0.4, f), width=0.22, origin=(0, oy, 0), rachis=4, base=0.3)
    return m


def palm_dead():
    m = Mesh()
    rng = random.Random(41)
    n = 4
    a0 = 0.4
    for k in range(n):
        a = a0 + (k / n) * TAU + (rng.random() - 0.5) * 0.6
        L = 2.3 + rng.random() * 0.5
        tint = 0.78 + rng.random() * 0.14
        frond(m, a, -0.55 - rng.random() * 0.3, 0.65, L, tint, WOOD, rng, n_side=8, fold=1.05, width=0.14, sway_scale=0.3, origin=(0, -0.35, 0), droop_tip=0.3)
    return m


def palm_dates():
    m = Mesh()
    rng = random.Random(23)
    n = 3
    S = 5
    for k in range(n):
        a = 0.9 + (k / n) * TAU + (rng.random() - 0.5) * 0.5
        ca, sa = math.cos(a), math.sin(a)
        tint = 0.06 + rng.random() * 0.12  # ochre to amber in the dye ramp

        def P(d, y):
            return (ca * d, y, sa * d)

        # the stalk: a ribbon arching out from among the frond bases
        across = (-sa * 0.035, 0, ca * 0.035)
        s0 = P(0.3, -0.05)
        s1 = P(0.62, -0.32)
        v = [m.v(sub(s0, across), (CLOTH, tint * 0.5, 0)), m.v(add(s0, across), (CLOTH, tint * 0.5, 0)),
             m.v(add(s1, across), (CLOTH, tint * 0.5, 0)), m.v(sub(s1, across), (CLOTH, tint * 0.5, 0))]
        m.q(*v)
        # the cluster: a lumpy hanging bunch, wider than long
        top = m.v(P(0.64, -0.36), (CLOTH, tint, 0))
        cx, cz = ca * 0.68, sa * 0.68
        r1 = [m.v(p, (CLOTH, tint, 0)) for p in ring_pts(cx, -0.52, cz, 0.17, S, a, [1 + 0.35 * (rng.random() - 0.5) for _ in range(S)])]
        r2 = [m.v(p, (CLOTH, tint * 1.1, 0)) for p in ring_pts(cx + ca * 0.02, -0.74, cz + sa * 0.02, 0.15, S, a + math.pi / S, [1 + 0.4 * (rng.random() - 0.5) for _ in range(S)])]
        bot = m.v((cx + ca * 0.04, -0.95, cz + sa * 0.04), (CLOTH, tint * 1.2, 0))
        m.fan(r1, top, True)
        m.band(r1, r2)
        m.fan(r2, bot, False)
    return m


# ---------------------------------------------------------------- shrubs


def blade(m, base, a, e, L, w, tint, rng, sway0=0.0):
    """A pointed leaf card: base, two shoulders, a tip, arching down a little."""
    d = (math.cos(e) * math.cos(a), math.sin(e), math.cos(e) * math.sin(a))
    s = (-math.sin(a), 0, math.cos(a))
    mid = add(base, mul(d, L * 0.45))
    tip = add(add(base, mul(d, L)), (0, -L * 0.12 * math.cos(e), 0))
    sw = lambda p: min(1.0, max(0.0, p[1]))
    b = m.v(base, (PLANT, tint, sw(base) * 0.6 + sway0))
    l = m.v(sub(mid, mul(s, w)), (PLANT, tint, sw(mid)))
    r = m.v(add(mid, mul(s, w)), (PLANT, tint, sw(mid)))
    t = m.v(tip, (PLANT, tint * 1.05, sw(tip)))
    m.t(b, l, t)
    m.t(b, t, r)


def lump(m, c, rx, ry, S, rows, tint, rng, flat_bottom=True):
    """A faceted dome of foliage."""
    rings = []
    for k in range(1, rows + 1):
        phi = (k / (rows + 1)) * (math.pi / 2) if flat_bottom else (k / (rows + 1)) * math.pi - math.pi / 2
        y = c[1] + math.sin(phi) * ry
        r = math.cos(phi) * rx
        rings.append([m.v(p, (PLANT, tint * (0.8 + 0.12 * k), min(1.0, max(0.0, p[1]))))
                      for p in ring_pts(c[0], y, c[2], r, S, k * 0.5, [1 + 0.25 * (rng.random() - 0.5) for _ in range(S)])])
    base = [m.v(p, (PLANT, tint * 0.7, 0.0)) for p in ring_pts(c[0], c[1] - 0.02, c[2], rx * 1.02, S, 0)]
    m.band(base, rings[0])
    for k in range(len(rings) - 1):
        m.band(rings[k], rings[k + 1])
    top = m.v((c[0], c[1] + ry, c[2]), (PLANT, tint, min(1.0, c[1] + ry)))
    m.fan(rings[-1], top, True)


def shrub(seed, thorny):
    m = Mesh()
    rng = random.Random(seed)
    tint = 0.45 if thorny else 0.62
    # a core of foliage, low and lumpy
    lump(m, (0, 0, 0), 0.5 if thorny else 0.6, 0.45 if thorny else 0.7, 6, 2, tint * 0.8, rng)
    # blades in layers: an inner, taller ring and an outer, lower, spreading ring
    nb = 28 if thorny else 24
    for k in range(nb):
        a = k * 2.39996 + rng.random() * 0.3
        layer = k % 3  # 0 inner and upright .. 2 outer and spreading
        d = (0.1, 0.3, 0.45)[layer]
        base = (math.cos(a) * d, (0.2, 0.12, 0.04)[layer], math.sin(a) * d)
        e = (1.15, 0.75, 0.35)[layer] + (rng.random() - 0.5) * 0.35
        L = (0.95, 0.85, 0.7)[layer] * (0.8 + 0.35 * rng.random())
        blade(m, base, a, e, L, (0.07 if thorny else 0.12) * (1.2 - 0.2 * layer), tint * (1.2, 1.0, 0.85)[layer], rng)
    if thorny:
        # bare twigs out through the foliage: a crossed pair of slivers each
        for k in range(6):
            a = rng.random() * TAU
            el = 0.3 + rng.random() * 0.8
            dvec = (math.cos(a) * math.cos(el), math.sin(el), math.sin(a) * math.cos(el))
            b0 = (dvec[0] * 0.3, 0.25 + 0.2 * dvec[1], dvec[2] * 0.3)
            e = add(b0, mul(dvec, 0.6 + rng.random() * 0.35))
            t = 0.035
            s = (-math.sin(a) * t, 0, math.cos(a) * t)
            tw = 0.35 + rng.random() * 0.2
            i0 = m.v(sub(b0, s), (WOOD, tw, 0.65))
            i1 = m.v(add(b0, s), (WOOD, tw, 0.65))
            i2 = m.v(e, (WOOD, tw, 1.0))
            m.t(i0, i1, i2)
            j0 = m.v(add(b0, (0, t, 0)), (WOOD, tw, 0.65))
            j1 = m.v(sub(b0, (0, t, 0)), (WOOD, tw, 0.65))
            j2 = m.v(e, (WOOD, tw, 1.0))
            m.t(j0, j1, j2)
    return m


# ---------------------------------------------------------------- rocks


def rock(seed, small):
    """A unit rock: rings at bedding heights, so the ledges run level whatever the rock's turn;
    each bed drawn in at its foot (the groove under the ledge above), the whole pushed about by
    noise, a boxy profile, a few joint faces sheared flat and a flat foot."""
    from mathutils import Vector, noise

    rng = random.Random(seed)
    S = 7 if small else 10 + seed % 2
    # bed tops, bottom to top, uneven
    beds = 2 if small else 3 + seed % 2
    ys = [-0.45]
    w = [0.6 + 0.8 * rng.random() for _ in range(beds)]
    top = 0.6 if small else 0.74 + 0.08 * rng.random()
    for k in range(beds):
        ys.append(ys[-1] + (top + 0.45) * w[k] / sum(w))
    off = Vector((rng.random() * 50, rng.random() * 50, rng.random() * 50))
    stretch = 1.0 + 0.2 * rng.random()
    # joint faces: vertical planes the rock has split along
    joints = []
    for k in range(1 if small else 2 + seed % 2):
        az = rng.random() * TAU
        joints.append((math.cos(az), math.sin(az), 0.7 + 0.15 * rng.random()))
    m = Mesh()
    shift = [(0.0, 0.0)]
    for k in range(beds):
        a = rng.random() * TAU
        shift.append((shift[-1][0] + 0.09 * math.cos(a), shift[-1][1] + 0.09 * math.sin(a)))

    def ring(yy, li, recess, shade):
        out = []
        cx = shift[li][0]  # each bed set back a little off the last
        cz = shift[li][1]
        narrow = 1 - 0.07 * li
        for i in range(S):
            a = -(i / S) * TAU + li * 0.37
            t = min(1.0, abs(yy) / 1.0)
            base_r = (1 - t ** 3) ** (1 / 3)  # boxy, not round
            p = Vector((math.cos(a) * base_r * stretch, yy, math.sin(a) * base_r))
            k = 1 + 0.3 * noise.noise(p * 1.3 + off) + 0.1 * noise.noise(p * 3.7 + off * 2)
            if recess:
                k *= 0.84 + 0.12 * (0.5 + 0.5 * noise.noise(p * 2.2 + off * 3))
            x, z = p.x * k * narrow + cx, p.z * k * narrow + cz
            for jx, jz, d in joints:
                e = x * jx + z * jz - d
                if e > 0:
                    x -= jx * e
                    z -= jz * e
            q = (x, yy + (0.03 * noise.noise(p * 3 + off) if -0.45 < yy < top else 0), z)
            sh = shade * mix(0.86, 1.0, smoothstep(-0.45, 0.1, yy))
            out.append(m.v(q, (sh,)))
        return out

    rings = [ring(-0.45, 0, False, 0.95)]
    for li in range(1, len(ys)):
        rings.append(ring(ys[li - 1] + 0.06, li, li > 1, 0.8 if li > 1 else 0.95))
        rings.append(ring(ys[li], li, False, 1.04))
    for k in range(len(rings) - 1):
        m.band(rings[k], rings[k + 1])
    foot = m.v((0, -0.45, 0), (0.82,))
    m.fan(rings[0], foot, False)
    tc = m.v((0.05 * (rng.random() - 0.5), top + 0.04, 0.05 * (rng.random() - 0.5)), (1.05,))
    m.fan(rings[-1], tc, True)
    return m


# ---------------------------------------------------------------- Blender side


def to_blender(p):
    """Game (x, y up, z forward) to Blender (x, y, z up); the exporter's +Y-up undoes it."""
    return (p[0], -p[2], p[1])


def make_mesh(name, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in m.pos], [], m.tri)
    me.validate(clean_customdata=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def models():
    out = {"PalmTrunk": palm_trunk()}
    for i in range(3):
        out[f"PalmCrown{i}"] = palm_crown(i)
    out["PalmDead"] = palm_dead()
    out["PalmDates"] = palm_dates()
    for i in range(3):
        out[f"Shrub{i}"] = shrub(100 + i, True)
    for i in range(2):
        out[f"Bush{i}"] = shrub(200 + i, False)
    for i in range(4):
        out[f"Boulder{i}"] = rock(300 + i, False)
    for i in range(3):
        out[f"Stone{i}"] = rock(400 + i, True)
    return out


def export(ms):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, m in ms.items():
        ob = make_mesh(name, m)
        me = ob.data
        if len(m.attr[0]) == 1:
            a = me.attributes.new("_shade", "FLOAT", "POINT")
            a.data.foreach_set("value", [t[0] for t in m.attr])
        else:
            a = me.attributes.new("_info", "FLOAT_VECTOR", "POINT")
            a.data.foreach_set("vector", [c for t in m.attr for c in t])
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


def colour(name, a):
    if len(a) == 1:
        k = a[0]
        return (0.62 * k, 0.45 * k, 0.33 * k)
    mat, tint, _ = a
    k = 0.8 + 0.4 * tint
    if mat == PLANT:
        return (0.3 * k, 0.42 * k, 0.17 * k)
    if mat == WOOD:
        k = 0.85 + 0.3 * tint
        return (0.45 * k, 0.33 * k, 0.24 * k)
    return (0.62, 0.36 + 0.3 * tint, 0.12)  # ochre to amber dates


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
    bg.inputs[1].default_value = 0.5
    sc.world = world

    mat = bpy.data.materials.new("col")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.95
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

    def place(name, x, y, rot=0.0, s=1.0, z=0.0):
        m = ms[name]
        ob = make_mesh(name + "_p", m)
        ob.location = (x, -z, y)
        ob.rotation_euler = (0, 0, rot)
        ob.scale = (s, s, s)
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for t in m.attr for c in (*colour(name, t), 1.0)])
        ob.data.materials.append(mat)
        for p in ob.data.polygons:
            p.use_smooth = False
        placed.append(ob)
        return ob

    def shoot(path, w, cz, elev=12, dist=60):
        cam.data.ortho_scale = w
        e = math.radians(elev)
        cam.location = (0, -dist * math.cos(e), cz + dist * math.sin(e))
        cam.rotation_euler = (math.radians(90 - elev), 0, 0)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    def clear():
        for ob in placed:
            bpy.data.objects.remove(ob)
        placed.clear()

    # palms: three, each a trunk, a crown and (some) dead fronds and dates
    for i, (x, extra) in enumerate([(-7, ("PalmDead", "PalmDates")), (0, ("PalmDates",)), (7, ("PalmDead",))]):
        place("PalmTrunk", x, 0)
        for n in (f"PalmCrown{i}",) + extra:
            place(n, x, FROND_Y, rot=i * 1.3)
    shoot(os.path.join(out_dir, "palms.png"), 22, 6.5, elev=8)
    shoot(os.path.join(out_dir, "palm_crowns_top.png"), 22, 6.5, elev=55)
    clear()
    place("PalmTrunk", 0, 0)
    place("PalmCrown1", 0, FROND_Y)
    place("PalmDead", 0, FROND_Y)
    place("PalmDates", 0, FROND_Y)
    shoot(os.path.join(out_dir, "palm_close.png"), 7.5, FROND_Y - 0.6, elev=10)
    clear()
    names = [f"Shrub{i}" for i in range(3)] + [f"Bush{i}" for i in range(2)]
    for i, n in enumerate(names):
        place(n, (i - 2) * 2.6, 0, rot=0.5 * i)
    shoot(os.path.join(out_dir, "shrubs.png"), 14, 0.6, elev=20)
    clear()
    names = [f"Boulder{i}" for i in range(4)] + [f"Stone{i}" for i in range(3)]
    for i, n in enumerate(names):
        big = n.startswith("Boulder")
        ob = place(n, (i - 3) * 3.6, 0.45 * (1.6 if big else 0.8), rot=0.7 * i)
        ob.scale = (2.0, 1.6, 1.6) if big else (1.0, 0.8, 0.8)  # as boulder() sizes them
    shoot(os.path.join(out_dir, "rocks.png"), 25, 1.2, elev=18)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ms = models()
    export(ms)
    for name, m in ms.items():
        print("PROP", name, "verts", len(m.pos), "tris", len(m.tri))
    print("PROPS", OUT, os.path.getsize(OUT), "bytes")
    if "--preview" in argv:
        preview(ms, argv[argv.index("--preview") + 1])


if __name__ == "__main__":
    main()
