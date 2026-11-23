"""The open desert's cacti, exported to public/art/cacti.glb.

    blender --background --python tools/blender/cacti.py                   # write the .glb
    blender --background --python tools/blender/cacti.py -- --preview DIR  # and render each species

The game (src/world/props.ts) still lays every cactus out itself: where a saguaro's arms leave
the trunk, how far they reach and how high they climb, how organ-pipe stems splay, where pads
grow from one another. Its collision comes from that layout, so it does not move. What these
models give it is the body: rib sections, crests, domes, flowers, fruit, spine tufts.

Stems are drawn in KNOT SPACE and swept along the game's own path (props.ts sweep()):
  y      the knot coordinate: 0 at the first knot of the path, 1 at the second and so on, linear
         in between; past the last knot (K - 1) y - (K - 1) is a distance along the end tangent
         in units of the stem radius (the domes and the flowers on them)
  x, z   offsets across the stem in units of the stem radius, x along the path's normal and z
         along normal x tangent (x, y, z right-handed, so the winding survives the sweep)
The profile (taper, a barrel's bulge) is in the model; the game passes one radius per stem.

  SaguaroTrunk0..2  K = 4: knots at 0, 0.12, 0.5 and 1 of the trunk from 0.3 m under the sand
                    to its shoulder; 9 rounded ribs, a ribbed dome; 1 has cream flowers on
                    the crown, 2 red fruit
  SaguaroArm0..1    K = 4: the root inside the trunk, half way round the elbow, the elbow's top,
                    the arm's top; 6 ribs; 1 has two flowers at the tip
  OrganStem0..2     K = 4: the root, out and up, the foot of the upright, its top; 6-7 ribs;
                    1 has a pale bloom at the tip
  Barrel0..2        K = 5: knots at 0, 0.3, 0.62, 0.86 and 1 of the body (leaning south in the
                    game); 11-12 deep ribs, spine tufts on the crests, a ring of flowers on the
                    crown (coloured by the game)

Pads and fruit are placed whole:
  PearPad0..2       a prickly-pear pad: x across in units of its half width, y along it in units
                    of its half height (base at -1, top at +1), z through it in units of its half
                    thickness
  PearFruit         one fruit in units of 0.05 m about its centre

Reeds for the oasis pools and pots (src/city/extra/plants.ts reeds()), unit height, root at 0,
scaled by the clump's height:

  Reeds0..2         a clump of tapering blades bending out, with cattail seed heads on stalks
  ReedGrass0..1     the same without heads (spiky grass in pots)
  _info (vec3)      as props.glb's plants: x material id (6 plant, 3 wood), y tint 0..1 (the
                    game's tint byte / 255), z sway 0..1 (0 at the root, 0.45 half way up, 0.75
                    at a tip)

Cactus _info (vec3): x what it is: 1 flesh (the game's cactus green and tint), 2 bloom (the
                    species' flower colour), 3 spine or wool (straw), 4 fruit (crimson);
                    y a shade multiplier (grooves darker, crests lighter); z unused (0)

No materials, no normals (the game works out flat ones), no texture coordinates.
"""

import math
import os
import random
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "cacti.glb"))

FLESH, BLOOM, SPINE, FRUIT = 1, 2, 3, 4


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
    return a + (b - a) * t


class Mesh:
    def __init__(self):
        self.pos = []
        self.attr = []
        self.tri = []

    def v(self, p, kind, shade):
        self.pos.append(tuple(p))
        self.attr.append((kind, shade, 0.0))
        return len(self.pos) - 1

    def t(self, a, b, c):
        self.tri.append((a, b, c))

    def t_out(self, a, b, c, ref):
        """A triangle wound to face away from ref."""
        pa, pb, pc = self.pos[a], self.pos[b], self.pos[c]
        n = cross(sub(pb, pa), sub(pc, pa))
        m = mul(add(add(pa, pb), pc), 1 / 3)
        if dot(n, sub(m, ref)) < 0:
            b, c = c, b
        self.tri.append((a, b, c))


# ---------------------------------------------------------------- stems


def section(ribs, depth, rounded):
    """One ring across a stem, unit radius, as (angle, radius, shade), angles decreasing (so
    the ring runs counter-clockwise seen down the tangent). Rounded ribs have a flat, narrow
    crest (two points) between grooves; plain ribs are a crest and a groove."""
    out = []
    step = TAU / ribs
    for j in range(ribs):
        c = -j * step
        if rounded:
            w = 0.17 * step
            out.append((c + w, 1.0, 1.06))
            out.append((c - w, 1.0, 1.06))
            out.append((c - 0.5 * step, 1.0 - depth, 0.78))
        else:
            out.append((c, 1.0, 1.05))
            out.append((c - 0.5 * step, 1.0 - depth, 0.8))
    return out


class Stem:
    """A ribbed stem in knot space: rings at given knot coordinates, then a dome."""

    def __init__(self, m, ribs, depth, rounded, roll=0.0):
        self.m = m
        self.sec = section(ribs, depth, rounded)
        self.ribs = ribs
        self.roll = roll
        self.prev = None

    def ring(self, y, scale, shade=1.0):
        r = []
        for a, rr, sh in self.sec:
            a += self.roll
            r.append(self.m.v((math.cos(a) * rr * scale, y, math.sin(a) * rr * scale), FLESH, sh * shade))
        if self.prev is not None:
            self.band(self.prev, r)
        self.prev = r
        return r

    def band(self, r0, r1):
        n = len(r0)
        for i in range(n):
            j = (i + 1) % n
            self.m.t(r0[i], r1[j], r1[i])
            self.m.t(r0[i], r0[j], r1[j])

    def apex(self, y, shade=1.05):
        c = self.m.v((0, y, 0), FLESH, shade)
        r = self.prev
        n = len(r)
        for i in range(n):
            self.m.t(r[i], r[(i + 1) % n], c)
        return c

    def crests(self):
        """Angles of the rib crests (the middle of each)."""
        return [self.roll - j * TAU / self.ribs for j in range(self.ribs)]


def cone(m, base, up, side, s, h, kind, shade, sides=4, tilt=0.0):
    """A small upright cone (a flower, a bud): `sides` triangles, apex along `up`."""
    up = norm(up)
    a = norm(cross(up, side))
    b = cross(a, up)
    ring = []
    for k in range(sides):
        t = (k / sides) * TAU + tilt
        p = add(base, add(mul(a, math.cos(t) * s), mul(b, math.sin(t) * s)))
        ring.append(m.v(p, kind, shade * (0.92 if k % 2 else 1.0)))
    tip = m.v(add(base, mul(up, h)), kind, shade * 1.1)
    for k in range(sides):
        m.t_out(ring[k], ring[(k + 1) % sides], tip, sub(base, mul(up, s)))


def bipyramid(m, c, up, s, h0, h1, kind, shade, sides=4, tilt=0.0):
    """A small closed bud or fruit: a ring of `sides` and a point above and below."""
    up = norm(up)
    a = norm(cross(up, (0.3, 0.1, 1.0)))
    b = cross(a, up)
    ring = []
    for k in range(sides):
        t = (k / sides) * TAU + tilt
        ring.append(m.v(add(c, add(mul(a, math.cos(t) * s), mul(b, math.sin(t) * s))), kind, shade))
    top = m.v(add(c, mul(up, h1)), kind, shade * 1.12)
    bot = m.v(sub(c, mul(up, h0)), kind, shade * 0.85)
    for k in range(sides):
        m.t_out(ring[k], ring[(k + 1) % sides], top, c)
        m.t_out(ring[k], ring[(k + 1) % sides], bot, c)


def tuft(m, ang, y, rad, size, shade=1.0):
    """Spines on a crest: one sliver standing out from it, a little up."""
    ca, sa = math.cos(ang), math.sin(ang)
    o = (ca * rad, y, sa * rad)
    side = (-sa * size * 0.5, 0, ca * size * 0.5)
    tip = add(o, (ca * size * 1.6, size * 0.9, sa * size * 1.6))
    i0 = m.v(sub(o, side), SPINE, shade)
    i1 = m.v(add(o, side), SPINE, shade)
    i2 = m.v(tip, SPINE, shade * 1.1)
    m.t_out(i0, i1, i2, (0, y + size * 3, 0))


def saguaro_trunk(v):
    m = Mesh()
    rng = random.Random(500 + v)
    ribs = 9
    s = Stem(m, ribs, (0.13, 0.15, 0.11)[v], True, roll=rng.random())
    # knots 0..3: the buried foot, just above the sand, half way, the shoulder
    s.ring(0.0, 0.98, 0.95)
    s.ring(1.0, 1.0)
    s.ring(2.0, 0.97)
    s.ring(3.0, 0.92)
    # the dome: ribs running on over the shoulder to the crown
    s.ring(3.0 + 0.42, 0.74, 1.04)
    s.apex(3.0 + 0.8, 1.08)
    # where the dome surface lies: rho (across) at d (along) between the ring and the apex
    def on_dome(rho):
        return 3.0 + 0.42 + (0.8 - 0.42) * (0.74 - rho) / 0.74 + 0.02

    crest = s.crests()
    if v == 1:
        # cream blossoms clustered on the crown, open faces turned up and out
        for k, j in enumerate((0, 3, 5, 8)):
            a = crest[j % ribs] + 0.1 * k
            rho = 0.42 + 0.08 * (k % 2)
            base = (math.cos(a) * rho, on_dome(rho), math.sin(a) * rho)
            up = norm((math.cos(a) * 0.55, 1.0, math.sin(a) * 0.55))
            cone(m, base, up, (math.cos(a + 1.6), 0, math.sin(a + 1.6)), 0.26, 0.16, BLOOM, 1.0, sides=5, tilt=k)
    elif v == 2:
        # ripe fruit split at the tips of the old flower stalks
        for k, j in enumerate((1, 4, 7)):
            a = crest[j % ribs]
            rho = 0.45
            c = (math.cos(a) * rho, on_dome(rho) + 0.12, math.sin(a) * rho)
            bipyramid(m, c, (math.cos(a) * 0.4, 1.0, math.sin(a) * 0.4), 0.13, 0.12, 0.2, FRUIT, 1.0, tilt=k)
    return m


def saguaro_arm(v):
    m = Mesh()
    rng = random.Random(600 + v)
    s = Stem(m, 6, 0.13, False, roll=rng.random())
    # knots: root inside the trunk, half round the elbow, the elbow's top, the arm's top
    s.ring(0.0, 0.92, 0.92)
    s.ring(1.0, 1.0)
    s.ring(2.0, 1.0)
    s.ring(3.0, 0.94)
    s.apex(3.0 + 0.5, 1.08)
    if v == 1:
        for k in range(2):
            a = s.crests()[k * 3] + 0.3
            rho = 0.4
            base = (math.cos(a) * rho, 3.0 + 0.5 * (0.94 - rho) / 0.94 + 0.02, math.sin(a) * rho)
            cone(m, base, (math.cos(a) * 0.6, 1.0, math.sin(a) * 0.6), (math.cos(a + 1.6), 0, math.sin(a + 1.6)), 0.3, 0.2, BLOOM, 1.0, sides=5, tilt=k)
    return m


def organ_stem(v):
    m = Mesh()
    rng = random.Random(700 + v)
    s = Stem(m, (6, 6, 7)[v], 0.19, False, roll=rng.random())
    s.ring(0.0, 0.88, 0.9)
    s.ring(1.0, 1.0)
    s.ring(2.0, 1.0)
    s.ring(3.0, 0.95)
    s.apex(3.0 + 0.55, 1.08)
    if v == 1:
        a = s.crests()[0]
        base = (math.cos(a) * 0.4, 3.0 + 0.55 * 0.55, math.sin(a) * 0.4)
        cone(m, base, (math.cos(a) * 0.5, 1.0, math.sin(a) * 0.5), (math.cos(a + 1.6), 0, math.sin(a + 1.6)), 0.4, 0.3, BLOOM, 1.0, sides=5)
    return m


BARREL_T = (0.0, 0.3, 0.62, 0.86, 1.0)


def barrel(v):
    m = Mesh()
    rng = random.Random(800 + v)
    ribs = (12, 12, 11)[v]
    s = Stem(m, ribs, 0.2, False, roll=rng.random())
    prof = (0.86, 1.0, 0.97, 0.8, 0.5)
    for k, p in enumerate(prof):
        s.ring(float(k), p, 0.95 if k == 0 else 1.0)
    # the crown: a shallow dome over the last ring, woolly at its centre
    s.apex(4.0 + 0.07, 0.96)
    # spines: a tuft on every crest, high on the body where they stand out against the sky
    for j, a in enumerate(s.crests()):
        y = 3.0 + 0.35 * ((j + v) % 2)
        rad = lerp(0.8, 0.5, (y - 3.0)) if y > 3.0 else 0.8
        tuft(m, a, y, rad, 0.07 if (j % 3) else 0.09, 1.0)
    # flowers: a ring of little cups round the crown
    nf = (6, 5, 7)[v]
    for k in range(nf):
        a = (k / nf) * TAU + 0.35 * rng.random()
        rho = 0.3 + 0.04 * rng.random()
        base = (math.cos(a) * rho, 4.0 + 0.07 * (0.5 - rho) / 0.5 + 0.005, math.sin(a) * rho)
        up = norm((math.cos(a) * 0.35, 1.0, math.sin(a) * 0.35))
        cone(m, base, up, (math.cos(a + 1.6), 0, math.sin(a + 1.6)), 0.1 + 0.025 * rng.random(), 0.13, BLOOM, 1.0, sides=3, tilt=a)
    return m


def pear_pad(v):
    """A pad: a lens, narrow at the joint, broad above; each face swells to a low ridge."""
    m = Mesh()
    RIM = 10
    rim = []
    for k in range(RIM):
        th = (k / RIM) * TAU
        y = math.cos(th)
        w = math.sin(th)
        # obovate: broad above the middle, pinched toward the joint; 1 longer, 2 lopsided
        wf = (0.9 + 0.14 * y) * (1 - 0.28 * max(0.0, -y) ** 2)
        if v == 1:
            wf *= 0.86
        if v == 2:
            wf *= 1.0 + 0.1 * w * (0.5 + 0.5 * y)
        z = 0.0
        sh = 0.9 if y > -0.5 else 0.84
        rim.append(m.v((w * wf, y * (1.06 if v == 1 else 1.0), z), FLESH, sh))
    up_set = [8, 9, 0, 1, 2]
    lo_set = [3, 4, 5, 6, 7]
    for side in (1, -1):
        c1 = m.v((0.04 * side if v == 2 else 0.0, 0.32, side * 1.0), FLESH, 1.07)
        c2 = m.v((0.0, -0.42, side * 0.78), FLESH, 1.0)

        def tri(a, b, c):
            pa, pb, pc = m.pos[a], m.pos[b], m.pos[c]
            n = cross(sub(pb, pa), sub(pc, pa))
            if n[2] * side < 0:
                b, c = c, b
            m.t(a, b, c)

        for i in range(len(up_set) - 1):
            tri(c1, rim[up_set[i]], rim[up_set[i + 1]])
        for i in range(len(lo_set) - 1):
            tri(c2, rim[lo_set[i]], rim[lo_set[i + 1]])
        tri(c1, rim[2], rim[3])
        tri(c1, rim[3], c2)
        tri(c2, rim[7], rim[8])
        tri(c2, rim[8], c1)
    return m


def pear_fruit():
    m = Mesh()
    S = 5
    ring = [m.v((math.cos(-k / S * TAU) * 0.9, 0.4, math.sin(-k / S * TAU) * 0.9), FRUIT, 1.0 if k % 2 else 0.92) for k in range(S)]
    top = m.v((0, 1.35, 0), FRUIT, 1.12)
    bot = m.v((0, -1.0, 0), FRUIT, 0.8)
    for k in range(S):
        m.t_out(ring[k], ring[(k + 1) % S], top, (0, 0.3, 0))
        m.t_out(ring[k], ring[(k + 1) % S], bot, (0, 0.3, 0))
    return m


PLANT, WOOD = 6, 3


def reed_sway(f):
    return 0.75 * max(0.0, f) ** 0.8


def reed_blade(m, rng, a, j, H, lean, wd, tint):
    """A blade: three pairs narrowing up it and a point, bending out the way it leans."""
    c, s = math.cos(a), math.sin(a)
    bx, bz = c * j, s * j
    side = (-s, 0, c)
    nrm = (c, 0.3, s)

    def at(f):
        ll = lean * f * f
        return (bx + c * ll, H * f, bz + s * ll)

    pairs = []
    for f, k in ((0.0, 1.0), (0.38, 0.85), (0.7, 0.55)):
        p = at(f)
        w = wd * k
        sh = tint * (0.85 + 0.25 * f)
        pairs.append((m.v(sub(p, mul(side, w)), PLANT, sh, reed_sway(f)), m.v(add(p, mul(side, w)), PLANT, sh, reed_sway(f))))
    tip = m.v(at(1.0), PLANT, tint * 1.12, reed_sway(1.0))
    for k in range(2):
        l0, r0 = pairs[k]
        l1, r1 = pairs[k + 1]
        m.t_out(l0, r0, r1, sub(at(0.5), mul(nrm, 1)))
        m.t_out(l0, r1, l1, sub(at(0.5), mul(nrm, 1)))
    m.t_out(pairs[2][0], pairs[2][1], tip, sub(at(0.5), mul(nrm, 1)))


def cattail(m, rng, a, j, H, lean):
    """A seed stalk: a thin ribbon up through a brown head, the spike over it."""
    c, s = math.cos(a), math.sin(a)
    bx, bz = c * j, s * j
    side = (-s * 0.008, 0, c * 0.008)

    def at(f):
        ll = lean * f * f
        return (bx + c * ll, H * f, bz + s * ll)

    tint = 0.5 + 0.2 * rng.random()
    p0, p1 = at(0.0), at(0.74)
    ref = (bx - c, H * 0.4, bz - s)
    v = [m.v(sub(p0, side), PLANT, tint, 0), m.v(add(p0, side), PLANT, tint, 0),
         m.v(add(p1, side), PLANT, tint, reed_sway(0.74)), m.v(sub(p1, side), PLANT, tint, reed_sway(0.74))]
    m.t_out(v[0], v[1], v[2], ref)
    m.t_out(v[0], v[2], v[3], ref)
    spike = m.v(at(1.0), PLANT, tint * 0.8, reed_sway(1.0))
    q = at(0.9)
    m.t_out(m.v(sub(q, side), PLANT, tint, reed_sway(0.9)), m.v(add(q, side), PLANT, tint, reed_sway(0.9)), spike, ref)
    # the head: a long three-sided spindle
    ht = 0.16 + 0.12 * rng.random()
    hr = 0.028
    lo, hi = at(0.72), at(0.88)
    bot = m.v(lo, WOOD, ht * 0.8, 0.6)
    top = m.v(hi, WOOD, ht * 1.1, 0.68)
    r0, r1 = [], []
    for k in range(3):
        t = k / 3 * TAU + a
        d = (math.cos(t) * hr, 0, math.sin(t) * hr)
        r0.append(m.v(add(at(0.75), d), WOOD, ht, 0.62))
        r1.append(m.v(add(at(0.85), mul(d, 0.85)), WOOD, ht * 1.05, 0.66))
    for k in range(3):
        n = (k + 1) % 3
        cen = at(0.8)
        m.t_out(bot, r0[k], r0[n], cen)
        m.t_out(r0[k], r1[k], r1[n], cen)
        m.t_out(r0[k], r1[n], r0[n], cen)
        m.t_out(r1[k], top, r1[n], cen)


def reeds(seed, heads):
    m = PlantMesh()
    rng = random.Random(seed)
    n = 11 if heads else 9
    for k in range(n):
        a = k * 2.39996 + rng.random() * 0.4
        j = rng.random() * 0.12
        H = 0.65 + rng.random() * 0.5
        lean = H * (0.12 + rng.random() * 0.3)
        wd = 0.02 + H * 0.008
        reed_blade(m, rng, a, j, H, lean, wd, (90 + rng.random() * 120) / 255)
    if heads:
        for k in range(3 + seed % 2):
            a = k * 2.1 + rng.random() * 0.6
            cattail(m, rng, a, rng.random() * 0.06, 0.95 + rng.random() * 0.25, 0.05 + rng.random() * 0.1)
    return m


class PlantMesh(Mesh):
    def v(self, p, mat, tint, sway=0.0):
        self.pos.append(tuple(p))
        self.attr.append((float(mat), tint, sway))
        return len(self.pos) - 1


def models():
    out = {}
    for i in range(3):
        out[f"SaguaroTrunk{i}"] = saguaro_trunk(i)
    for i in range(2):
        out[f"SaguaroArm{i}"] = saguaro_arm(i)
    for i in range(3):
        out[f"OrganStem{i}"] = organ_stem(i)
    for i in range(3):
        out[f"Barrel{i}"] = barrel(i)
    for i in range(3):
        out[f"PearPad{i}"] = pear_pad(i)
    out["PearFruit"] = pear_fruit()
    for i in range(3):
        out[f"Reeds{i}"] = reeds(900 + i, True)
    for i in range(2):
        out[f"ReedGrass{i}"] = reeds(950 + i, False)
    return out


# ---------------------------------------------------------------- the sweep (as props.ts does it)


def frames(pts):
    """Tangent, normal and binormal (normal x tangent) at each knot, by parallel transport."""
    K = len(pts)
    T, N, B = [], [], []
    n = None
    prev = None
    for i in range(K):
        if i == 0:
            t = norm(sub(pts[1], pts[0]))
        elif i == K - 1:
            t = norm(sub(pts[K - 1], pts[K - 2]))
        else:
            t = norm(sub(pts[i + 1], pts[i - 1]))
        if i == 0:
            n = (0, 0, 1) if abs(t[0]) > 0.9 else (1, 0, 0)
            n = norm(sub(n, mul(t, dot(n, t))))
        else:
            # rotate n by the turn from prev to t
            ax = cross(prev, t)
            s = math.sqrt(dot(ax, ax))
            c = dot(prev, t)
            if s > 1e-9:
                ax = mul(ax, 1 / s)
                ang = math.atan2(s, c)
                n = add(add(mul(n, math.cos(ang)), mul(cross(ax, n), math.sin(ang))), mul(ax, dot(ax, n) * (1 - math.cos(ang))))
        prev = t
        T.append(t)
        N.append(n)
        B.append(norm(cross(n, t)))
    return T, N, B


def sweep_point(p, pts, r, fr):
    T, N, B = fr
    K = len(pts)
    x, y, z = p
    if y <= K - 1:
        k = min(int(math.floor(max(y, 0.0))), K - 2)
        f = y - k
        P = add(pts[k], mul(sub(pts[k + 1], pts[k]), f))
        n = norm(add(mul(N[k], 1 - f), mul(N[k + 1], f)))
        b = norm(add(mul(B[k], 1 - f), mul(B[k + 1], f)))
    else:
        P = add(pts[K - 1], mul(T[K - 1], (y - (K - 1)) * r))
        n, b = N[K - 1], B[K - 1]
    return add(P, add(mul(n, x * r), mul(b, z * r)))


def swept(m, pts, r):
    fr = frames(pts)
    out = Mesh()
    out.pos = [sweep_point(p, pts, r, fr) for p in m.pos]
    out.attr = list(m.attr)
    out.tri = list(m.tri)
    return out


def check_winding(name, m, knots):
    """Every flesh face of a straight stem should face away from its axis."""
    bad = 0
    for a, b, c in m.tri:
        if any(m.attr[i][0] != FLESH for i in (a, b, c)):
            continue
        pa, pb, pc = m.pos[a], m.pos[b], m.pos[c]
        n = cross(sub(pb, pa), sub(pc, pa))
        mid = mul(add(add(pa, pb), pc), 1 / 3)
        if name.startswith("Pear"):
            ref = (0, mid[1], 0)
        else:
            ref = (0, mid[1], 0) if mid[1] < knots - 1 else (0, knots - 1 - 0.5, 0)
        if dot(n, sub(mid, ref)) <= 0:
            bad += 1
    return bad


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
        a = ob.data.attributes.new("_info", "FLOAT_VECTOR", "POINT")
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


GREEN = (0.3, 0.42, 0.2)
BLOOMS = {"saguaro": (0.95, 0.92, 0.78), "barrel": (0.95, 0.62, 0.15), "organ": (0.92, 0.62, 0.66)}


def colour(a, species):
    if species == "reed":
        mat, tint, _ = a
        k = 0.8 + 0.4 * tint
        return (0.3 * k, 0.42 * k, 0.17 * k) if mat == PLANT else (0.4 * k, 0.26 * k, 0.15 * k)
    kind, sh, _ = a
    if kind == FLESH:
        return mul(GREEN, sh)
    if kind == BLOOM:
        return mul(BLOOMS[species], sh)
    if kind == SPINE:
        return mul((0.86, 0.78, 0.55), sh)
    return mul((0.62, 0.12, 0.22), sh)


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

    def put(m, species):
        ob = make_mesh(f"p{len(placed)}", m)
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for t in m.attr for c in (*colour(t, species), 1.0)])
        ob.data.materials.append(mat)
        for p in ob.data.polygons:
            p.use_smooth = False
        placed.append(ob)

    def shoot(path, w, cz, elev=12, dist=60, cx=0.0):
        cam.data.ortho_scale = w
        e = math.radians(elev)
        cam.location = (cx, -dist * math.cos(e), cz + dist * math.sin(e))
        cam.rotation_euler = (math.radians(90 - elev), 0, 0)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    def clear():
        for ob in placed:
            bpy.data.objects.remove(ob)
        placed.clear()

    tris = {}

    def count(species, m):
        tris[species] = tris.get(species, 0) + len(m.tri)

    def saguaro(x, z, H, R, lean, arms, tv, seed):
        rng = random.Random(seed)
        g = 0.0
        knots = [(x + lean[0] * t * t, g - 0.3 + (H + 0.3) * t, z + lean[1] * t * t) for t in (0, 0.12, 0.5, 1.0)]
        m = swept(ms[f"SaguaroTrunk{tv}"], knots, R)
        put(m, "saguaro")
        n = len(m.tri)
        for i, (az, hf, outd, rc, topf) in enumerate(arms):
            ux, uz = math.cos(az), math.sin(az)
            ha = g + H * hf
            ra = R * 0.7
            out = R + outd
            tt = (ha - g + 0.3) / (H + 0.3)
            ax, azz = x + lean[0] * tt * tt, z + lean[1] * tt * tt
            armTop = max(ha + rc + 0.6, min(g + H * topf, g + H - 0.2))
            y0 = ha + 0.08 + rc

            def at(d, y):
                return (ax + ux * d, y, azz + uz * d)

            s45 = math.sin(math.pi / 4)
            ak = [at(R * 0.2, ha - 0.04), at(out - rc + rc * s45, ha + 0.08 + rc * (1 - s45)), at(out, y0), at(out, armTop)]
            am = swept(ms[f"SaguaroArm{(i + seed) % 2}"], ak, ra)
            put(am, "saguaro")
            n += len(am.tri)
        return n

    # saguaros: an old one with three arms, one with two (flowering), a young one, a one-armed
    counts = []
    counts.append(saguaro(-6, 0, 7.5, 0.4, (0.1, -0.05), [(0.3, 0.38, 0.6, 0.42, 0.85), (2.6, 0.5, 0.75, 0.36, 0.78), (4.4, 0.45, 0.5, 0.45, 0.92)], 0, 1))
    counts.append(saguaro(-1, 0, 6.0, 0.36, (-0.12, 0.06), [(0.1, 0.42, 0.7, 0.4, 0.8), (3.3, 0.36, 0.55, 0.32, 0.7)], 1, 2))
    counts.append(saguaro(3, 0, 2.6, 0.26, (0.05, 0.08), [], 2, 3))
    counts.append(saguaro(7, 0, 5.2, 0.33, (0.05, 0.1), [(3.0, 0.5, 0.6, 0.35, 0.82)], 0, 4))
    shoot(os.path.join(out_dir, "saguaros.png"), 20, 4.0, elev=8)
    shoot(os.path.join(out_dir, "saguaros_top.png"), 20, 3.0, elev=50)
    clear()
    saguaro(0, 0, 6.0, 0.36, (-0.12, 0.06), [(0.1, 0.42, 0.7, 0.4, 0.8), (3.3, 0.36, 0.55, 0.32, 0.7)], 1, 2)
    shoot(os.path.join(out_dir, "saguaro_close.png"), 4.2, 5.2, elev=20)
    clear()
    print("SAGUARO tris", counts)

    # barrels: each variant, and a cluster as barrels() lays one out
    bc = []
    for i, (x, H) in enumerate([(-3.2, 1.5), (-1.0, 1.1), (1.0, 0.8), (3.0, 1.3)]):
        R = H * 0.42
        lean = 0.12
        y0 = -0.15
        L = H + 0.15
        knots = [(x, y0 + math.cos(lean) * L * t, math.sin(lean) * L * t) for t in BARREL_T]
        bm = swept(ms[f"Barrel{i % 3}"], knots, R)
        put(bm, "barrel")
        bc.append(len(bm.tri))
    shoot(os.path.join(out_dir, "barrels.png"), 8.5, 0.8, elev=14)
    shoot(os.path.join(out_dir, "barrels_top.png"), 8.5, 0.6, elev=55)
    clear()
    print("BARREL tris", bc)

    # organ pipe: stems out from one root and up
    rng = random.Random(9)
    n = 7
    spread = 0.45
    H0 = 4.0
    on = 0
    for i in range(n):
        a = (i / n) * TAU + (rng.random() - 0.5) * 0.6
        ux, uz = math.cos(a), math.sin(a)
        rs = 0.13 + rng.random() * 0.07
        out = spread + 0.3 + rng.random() * 0.6
        Hi = H0 * (0.55 + rng.random() * 0.5)
        knots = [(ux * 0.1, -0.3, uz * 0.1), (ux * out * 0.8, 0.55, uz * out * 0.8), (ux * out, 1.0, uz * out), (ux * out, Hi, uz * out)]
        om = swept(ms[f"OrganStem{i % 3}"], knots, rs)
        put(om, "organ")
        on += len(om.tri)
    shoot(os.path.join(out_dir, "organ.png"), 7, 2.2, elev=10)
    clear()
    print("ORGAN tris", on)

    # prickly pear: pads grown from one another's rims, fruit on a few
    rng = random.Random(4)
    pc = 0

    def pad(c, u, nn, w, hh, T, v, shade):
        nonlocal pc
        s = cross(u, nn)
        pm = Mesh()
        src = ms[f"PearPad{v}"]
        pm.pos = [add(c, add(add(mul(s, p[0] * w), mul(u, p[1] * hh)), mul(nn, p[2] * T))) for p in src.pos]
        pm.attr = [(a[0], a[1] * shade, 0) for a in src.attr]
        pm.tri = list(src.tri)
        put(pm, "barrel")
        pc += len(pm.tri)

    def fruit(c):
        nonlocal pc
        fm = Mesh()
        src = ms["PearFruit"]
        fm.pos = [add(c, mul(p, 0.05)) for p in src.pos]
        fm.attr = list(src.attr)
        fm.tri = list(src.tri)
        put(fm, "barrel")
        pc += len(fm.tri)

    def grow(base, u, nn, lvl, idx):
        w = (0.2 + rng.random() * 0.1) * (1 - lvl * 0.08)
        hh = w * (1.25 + rng.random() * 0.25)
        c = add(base, mul(u, hh * 0.9))
        pad(c, u, nn, w, hh, 0.065, idx[0] % 3, 0.85 if lvl == 0 else 1.0)
        idx[0] += 1
        s = cross(u, nn)
        if lvl >= 1 and rng.random() < 0.5:
            for k in range(3):
                th = (rng.random() - 0.5) * 1.6
                fruit(add(add(c, mul(u, hh * math.cos(th) + 0.04)), mul(s, w * math.sin(th))))
        if lvl >= 3:
            return
        kids = 1 + (rng.random() < 0.5)
        for k in range(kids):
            th = (-1 if rng.random() < 0.5 else 1) * (0.25 + rng.random() * 0.55)
            pb = add(add(c, mul(u, hh * math.cos(th))), mul(s, w * math.sin(th)))
            nu = add(mul(u, math.cos(th)), mul(s, math.sin(th)))
            nu = norm(add(nu, (0, 0.35, 0)))
            turn = (rng.random() - 0.5) * 1.6
            ct, st = math.cos(turn), math.sin(turn)
            nu = (nu[0] * ct - nu[2] * st, nu[1], nu[0] * st + nu[2] * ct)
            n2 = (nn[0] * ct - nn[2] * st, nn[1], nn[0] * st + nn[2] * ct)
            n2 = norm(sub(n2, mul(nu, dot(n2, nu))))
            grow(pb, nu, n2, lvl + 1, idx)

    idx = [0]
    for i in range(3):
        a = (i / 3) * TAU
        yaw = rng.random() * TAU
        nn = (math.cos(yaw), 0, math.sin(yaw))
        s0 = cross((0, 1, 0), nn)
        lean = (rng.random() - 0.5) * 0.7
        u = add((0, math.cos(lean), 0), mul(s0, math.sin(lean)))
        grow((math.cos(a) * 0.3, -0.05, math.sin(a) * 0.3), u, nn, 0, idx)
    shoot(os.path.join(out_dir, "pear.png"), 5.5, 1.4, elev=14)
    shoot(os.path.join(out_dir, "pear_top.png"), 3.6, 0.6, elev=55)
    clear()
    print("PEAR tris", pc, "pads", idx[0])

    for i, n in enumerate(["Reeds0", "Reeds1", "Reeds2", "ReedGrass0", "ReedGrass1"]):
        rm = Mesh()
        src = ms[n]
        h = 1.8 if n.startswith("Reeds") else 0.9
        rm.pos = [((i - 2) * 1.6 + p[0] * h, p[1] * h, p[2] * h) for p in src.pos]
        rm.attr = list(src.attr)
        rm.tri = list(src.tri)
        put(rm, "reed")
    shoot(os.path.join(out_dir, "reeds.png"), 9, 1.0, elev=10)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ms = models()
    knots = {"SaguaroTrunk": 4, "SaguaroArm": 4, "OrganStem": 4, "Barrel": 5}
    for name, m in ms.items():
        kk = next((v for k, v in knots.items() if name.startswith(k)), 0)
        wind = check_winding(name, m, kk) if not name.startswith("Reed") else "-"
        print("CACTUS", name, "verts", len(m.pos), "tris", len(m.tri), "inward", wind)
    export(ms)
    print("CACTI", OUT, os.path.getsize(OUT), "bytes")
    if "--preview" in argv:
        preview(ms, argv[argv.index("--preview") + 1])


main()
