"""The open-world settlements' structures, exported to public/art/settlements.glb.

    blender --background --python tools/blender/settlements.py                   # write the .glb
    blender --background --python tools/blender/settlements.py -- --preview DIR  # and render each piece

The game (src/world/settlements.ts) still lays every settlement out itself, draws every random
number it drew before and keeps the collision its plain boxes give; these are only the bodies
drawn in their place. Each piece is in its own frame, in metres, as the builder there places it:

  x  along the piece (a tent's ridge, a hut's width, an awning's width)
  y  up, 0 at the ground (a hut's floor, a tower's foot)
  z  toward the front (a tent's open side, a hut's door wall)

Pieces the game stretches to its own sizes are drawn at a reference size and cut into a middle
that stretches and margins that only move (see settlements.ts stretch()):

  TentA..C      ridge length 9 (x -4.5..4.5, poles at 0 and +-4.2), half depth 3.3, ridge 2.9,
                eaves 1.3; the back and the -x end hang to the ground. x margin 1.5
  HutBody0..2   6 x 5 x 3.2 (wall top), the parapet above to about 3.55; y -1..0 is the footing,
                which the game stretches down to its own foot. x, z margins 1.2; y keeps the top
                0.9 and the bottom 0.4
  HutRoom       the same, plainer (no footing), for the upper room on some roofs
  HutDoor       a door in a wall at z = 0: jambs, a plank door, a log lintel, a sill
  HutWindow     a small window centred on (0, 0, 0) in a wall at z = 0
  HutBeam       a roof beam's end poking out of a wall at z = 0
  WindTower0..1 a 2.3 m shaft from y -1 to the cap at 10.8; the game stretches y 0.5..6 to its
                height, keeps the catchers above as they are
  Awning0..1    cloth on four poles at x +-2.2, z +-1.6, about 2.5 up; scaled to the awning
  Kiln0..1      a beehive kiln for R = 3.1, its mouth to +x; scaled by R / 3.1
  Well0..1      a stone ring of radius 1.7 with its frame along x
  Fire0..1      a ring of stones of radius 1 round a fire; scaled by the fire's size

_part (float), per vertex: what the vertex is, which the game colours as its stone material
does (settlements.ts PART):
  0 mud wall   1 mud, lighter (parapet, caps)   2 footing   3 wood   4 dark wood   5 dark (an
  opening)   6 cloth (the piece's tint)   7 cloth, the second shade   8 flame   9 stone (rock
  palette)   10 rope   11 goat hair   12 goat hair, the pale woven band   13 goat hair, the walls
  14 soot   15 a bucket's pale wood

No materials, no normals (the game works out flat ones), no texture coordinates.
"""

import math
import os
import random
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "settlements.glb"))

MUD, MUD_L, FOOT, WOOD, WOOD_D, DARK, CLOTH, CLOTH_B, FLAME, STONE, ROPE, HAIR, HAIR_P, HAIR_W, SOOT, BUCKET = range(16)


# ---------------------------------------------------------------- vectors


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def norm(a):
    n = length(a) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def yaw(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


# ---------------------------------------------------------------- mesh


class Mesh:
    """Vertices in the game frame, a part id each, and triangles."""

    def __init__(self):
        self.pos = []
        self.part = []
        self.tri = []

    def v(self, p, part):
        self.pos.append(tuple(p))
        self.part.append(part)
        return len(self.pos) - 1

    def t(self, a, b, c):
        self.tri.append((a, b, c))

    def q(self, a, b, c, d):
        self.tri.append((a, b, c))
        self.tri.append((a, c, d))

    def ring(self, pts, part):
        return [self.v(p, part) for p in pts]

    def band(self, r0, r1, closed=True):
        n = len(r0)
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            self.q(r0[i], r0[j], r1[j], r1[i])

    def fan(self, r, c, up=True):
        n = len(r)
        for i in range(n):
            j = (i + 1) % n
            if up:
                self.t(r[j], r[i], c)
            else:
                self.t(r[i], r[j], c)

    def grid(self, rows, part, closed=False):
        """rows: lists of points of equal length; one strip of quads between each pair."""
        ids = [self.ring(r, part) for r in rows]
        for a, b in zip(ids, ids[1:]):
            self.band(a, b, closed)
        return ids

    def merge(self, other):
        o = len(self.pos)
        self.pos += other.pos
        self.part += other.part
        self.tri += [(a + o, b + o, c + o) for a, b, c in other.tri]


def box(m, c, size, part, ry=0.0, open_back=False, open_bottom=False, rx=0.0, rz=0.0):
    """An axis box of the given size about c, turned by rz (about z), rx (about x), then ry."""
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2

    def P(x, y, z):
        p = (x, y, z)
        if rz:
            cz, sz = math.cos(rz), math.sin(rz)
            p = (p[0] * cz - p[1] * sz, p[0] * sz + p[1] * cz, p[2])
        if rx:
            cx, sx = math.cos(rx), math.sin(rx)
            p = (p[0], p[1] * cx - p[2] * sx, p[1] * sx + p[2] * cx)
        return add(c, yaw(p, ry))

    v = [m.v(P(x, y, z), part) for y in (-hy, hy) for z in (-hz, hz) for x in (-hx, hx)]
    # v index: y*4 + z*2 + x
    m.q(v[4], v[6], v[7], v[5])  # top
    if not open_bottom:
        m.q(v[0], v[1], v[3], v[2])
    m.q(v[2], v[3], v[7], v[6])  # front (+z)
    if not open_back:
        m.q(v[0], v[4], v[5], v[1])
    m.q(v[0], v[2], v[6], v[4])  # -x
    m.q(v[1], v[5], v[7], v[3])  # +x


def frame_of(d):
    d = norm(d)
    up = (0, 1, 0) if abs(d[1]) < 0.9 else (1, 0, 0)
    a = norm(cross(d, up))
    b = cross(a, d)
    return a, b


def prism(m, p0, p1, r0, part, n=5, r1=None, caps=(True, True), rot=0.0, flat=1.0):
    """A pole of n sides from p0 to p1, radius r0 tapering to r1."""
    r1 = r0 if r1 is None else r1
    a, b = frame_of(sub(p1, p0))

    def ring(c, r):
        out = []
        for i in range(n):
            t = rot + i / n * TAU
            out.append(add(c, add(mul(a, math.cos(t) * r), mul(b, math.sin(t) * r * flat))))
        return out

    ra = m.ring(ring(p0, r0), part)
    rb = m.ring(ring(p1, r1), part)
    m.band(ra, rb)
    if caps[0]:
        m.fan(ra, m.v(p0, part), up=False)
    if caps[1]:
        m.fan(rb, m.v(p1, part), up=True)


def polyline_tube(m, pts, r, part, n=3):
    for p0, p1 in zip(pts, pts[1:]):
        prism(m, p0, p1, r, part, n=n, caps=(False, False))


def rrect(hx, hz, rc, seg, y):
    """A rounded rectangle at height y, counter-clockwise seen from above (+y)."""
    out = []
    corners = [(hx - rc, hz - rc, 0), (-(hx - rc), hz - rc, 1), (-(hx - rc), -(hz - rc), 2), (hx - rc, -(hz - rc), 3)]
    for cx, cz, k in corners:
        for i in range(seg + 1):
            a = (k + i / seg) * (math.pi / 2)
            out.append((cx + math.cos(a) * rc, y, cz + math.sin(a) * rc))
    return out


def circle(r, y, n, rot=0.0, cx=0.0, cz=0.0, jit=None):
    out = []
    for i in range(n):
        a = rot + i / n * TAU
        rr = r * (1 + (jit[i] if jit else 0))
        out.append((cx + math.cos(a) * rr, y, cz + math.sin(a) * rr))
    return out


def rock(m, c, rx, ry, rz, part, rng, n=4):
    """A small rough stone sitting on the ground: a wide foot, a narrower shoulder, a top."""
    rot = rng.uniform(0, TAU)
    foot, shoulder = [], []
    for i in range(n):
        a = rot + i / n * TAU
        k = rng.uniform(0.85, 1.15)
        foot.append((c[0] + math.cos(a) * rx * k, c[1] - ry * 0.55, c[2] + math.sin(a) * rz * k))
        a2 = a + math.pi / n * rng.uniform(0.6, 1.4)
        shoulder.append((c[0] + math.cos(a2) * rx * 0.7, c[1] + ry * rng.uniform(0.25, 0.5), c[2] + math.sin(a2) * rz * 0.7))
    f = m.ring(foot, part)
    s = m.ring(shoulder, part)
    m.band(f, s)
    m.fan(s, m.v((c[0] + rng.uniform(-0.1, 0.1) * rx, c[1] + ry * 0.75, c[2] + rng.uniform(-0.1, 0.1) * rz), part), up=True)


# ---------------------------------------------------------------- the black tent

TENT_L, TENT_HALF, TENT_RIDGE, TENT_EAVE = 9.0, 3.3, 2.9, 1.3


def tent(variant):
    """A black goat-hair tent: the roof sags between its poles, the back and one end hang to the ground."""
    rng = random.Random(10 + variant)
    m = Mesh()
    L, H, R, E = TENT_L, TENT_HALF, TENT_RIDGE, TENT_EAVE
    poles = [-L / 2 + 0.3, 0.0, L / 2 - 0.3]
    # x stations: the ends, each pole, and two between each pair (where the cloth sags)
    xs = [-L / 2 - 0.15, poles[0], -2.8, -1.4, poles[1], 1.4, 2.8, poles[2], L / 2 + 0.15]
    low = 0.15 if variant != 2 else 0.05  # a slightly lower, longer-backed tent in variant 2

    def sag(x):
        # 0 at a pole, deepest half way between two: the cloth hangs from its pole tops
        d = min(abs(x - p) for p in poles)
        span = 4.2
        return 0.42 * math.sin(min(d / span, 0.5) * math.pi) if abs(x) <= poles[2] else 0.1 + (abs(x) - poles[2]) * 0.6

    def roof_y(x, z):
        # the ridge on its poles, falling straight to the eaves, flattening a little near them
        t = abs(z) / H
        y = R - (R - E) * (t ** 1.08)
        y -= sag(x) * (1 - 0.55 * t)
        if z < 0:
            y -= low * t
        return y

    # the roof in strips across z, the woven pale bands their own strips
    zs = [-H - 0.12, -2.3, -2.05, -1.1, 0.0, 1.1, 2.05, 2.3, H + 0.12]
    parts = [HAIR, HAIR_P, HAIR, HAIR, HAIR, HAIR, HAIR_P, HAIR]
    if variant == 1:
        zs = [-H - 0.12, -1.8, -1.55, 0.0, 1.55, 1.8, H + 0.12]
        parts = [HAIR, HAIR_P, HAIR, HAIR, HAIR_P, HAIR]
    for k in range(len(zs) - 1):
        row0 = [(x, roof_y(x, zs[k]), zs[k]) for x in xs]
        row1 = [(x, roof_y(x, zs[k + 1]), zs[k + 1]) for x in xs]
        m.grid([row0, row1], parts[k])
    # a valance along the open front, hanging a little below the eave between the front poles
    zf = H + 0.12
    top = [(x, roof_y(x, zf), zf) for x in xs]
    bot = [(x, roof_y(x, zf) - 0.28 - 0.08 * math.sin(i * 1.7), zf + 0.03) for i, x in enumerate(xs)]
    m.grid([top, bot], HAIR_P if variant == 1 else HAIR)
    # the back wall: from the back eave to the ground, kicked out a little at the foot and pegged
    zb = -H - 0.1
    wall_top = [(x, roof_y(x, zb) + 0.05, zb + 0.02) for x in xs]
    wall_mid = [(x, 0.45, zb - 0.12 - 0.05 * math.sin(i * 2.3)) for i, x in enumerate(xs)]
    wall_foot = [(x, -0.05, zb - 0.32) for x in xs]
    m.grid([wall_top, wall_mid, wall_foot], HAIR_W)
    # the -x end: a curtain from the roof's edge to the ground, folded where it meets the sand
    xe = -L / 2 - 0.05
    ez = [-H - 0.1, -2.2, -1.1, 0.0, 1.1, 2.2, H]
    etop = [(xe, roof_y(-L / 2, z) - 0.02, z) for z in ez]
    efoot = [(xe - 0.25 - 0.08 * (i % 2), -0.05, z) for i, z in enumerate(ez)]
    m.grid([etop, efoot], HAIR_W)
    # the +x end: its flap tied back, hanging from the ridge half the way down (variant 0) or let
    # down too (variant 2); variant 1 leaves it open
    xe2 = L / 2 + 0.05
    if variant == 0:
        fz = [-H - 0.1, -2.0, -0.9, 0.0]
        ftop = [(xe2, roof_y(L / 2, z) - 0.02, z) for z in fz]
        fbot = [(xe2 + 0.2, roof_y(L / 2, z) * 0.35 + 0.1 * i, z - 0.25) for i, z in enumerate(fz)]
        m.grid([ftop, fbot], HAIR_W)
    elif variant == 2:
        etop2 = [(xe2, roof_y(L / 2, z) - 0.02, z) for z in ez]
        efoot2 = [(xe2 + 0.25 + 0.08 * (i % 2), -0.05, z) for i, z in enumerate(ez)]
        m.grid([etop2, efoot2], HAIR_W)
    # poles: the ridge poles, the front eave poles; the back hangs from its own short poles
    for x in poles:
        prism(m, (x, -0.2, 0.0), (x, R + 0.12 - sag(x) * 0.0, 0.0), 0.075, WOOD, n=5, r1=0.06, caps=(False, True))
        prism(m, (x + 0.05, -0.2, H), (x, E + 0.1, H), 0.055, WOOD, n=4, caps=(False, True))
    # guy ropes from the front poles and the ridge ends out to pegs in the sand
    for x in poles:
        a = (x, E + 0.05, H)
        b = (x + (0.5 if x > 0 else -0.5 if x < 0 else 0.0), 0.0, H + 2.1)
        polyline_tube(m, [a, lerp(a, b, 0.5), b], 0.025, ROPE)
        prism(m, (b[0], -0.15, b[2]), (b[0], 0.2, b[2] + 0.05), 0.04, WOOD_D, n=3, caps=(False, True))
    for s in (-1, 1):
        a = (s * (L / 2 + 0.1), roof_y(s * L / 2, 0) - 0.05, 0.0)
        b = (s * (L / 2 + 1.9), 0.0, -0.3)
        polyline_tube(m, [a, b], 0.025, ROPE)
    # variant 2: an awning flap propped forward on two more poles over the door
    if variant == 2:
        fx = [-2.6, -1.3, 0.0, 1.3, 2.6]
        z0, z1 = H + 0.1, H + 1.5
        r0 = [(x, roof_y(x, H) + 0.02, z0) for x in fx]
        r1 = [(x, 1.75 - 0.18 * math.sin((x + 2.6) / 5.2 * math.pi * 2) ** 2, z1) for x in fx]
        m.grid([r0, r1], HAIR)
        for x in (-2.6, 2.6):
            prism(m, (x, -0.2, z1), (x, 1.8, z1), 0.05, WOOD, n=4, caps=(False, True))
    _ = rng
    return m


# ---------------------------------------------------------------- the mud-brick hut

HUT_W, HUT_D, HUT_H = 6.0, 5.0, 3.2


def hut_body(variant, room=False):
    """Rounded, slumped mud walls on a footing, a parapet round a flat roof. A room (the upper
    room some houses have on their roof) is plainer: no footing, squarer corners."""
    rng = random.Random(40 + variant + (7 if room else 0))
    m = Mesh()
    hx, hz = HUT_W / 2, HUT_D / 2
    seg = 1 if room else 2
    ph = [rng.uniform(0, TAU) for _ in range(3)]

    def ring(dx, y, rc=0.45, amp=0.0):
        pts = rrect(hx + dx, hz + dx, rc + max(dx, -0.3) * 0.5, seg, y)
        out = []
        for p in pts:
            a = math.atan2(p[2], p[0])
            out.append((p[0], p[1] + amp * (0.6 * math.sin(3 * a + ph[0]) + 0.4 * math.sin(5 * a + ph[1])), p[2]))
        return out

    if not room:
        # the footing: a plinth a little proud of the wall, from the foot (y -1) to the floor
        m.band(m.ring(ring(0.14, -1.0), FOOT), m.ring(ring(0.1, 0.06), FOOT))
    # the wall: flared at the foot, bellied, the top edge rounded and slumped
    w0 = m.ring(ring(0.07, 0.0), MUD)
    w1 = m.ring(ring(0.035, 1.6), MUD)
    w3 = m.ring(ring(-0.06, HUT_H, amp=0.05), MUD)
    if variant == 2 and not room:
        # a plastered band round the wall, a hand's width proud
        b0 = m.ring(ring(0.09, 2.55, amp=0.02), MUD_L)
        b1 = m.ring(ring(0.07, 2.78, amp=0.02), MUD_L)
        m.band(w0, w1)
        m.band(w1, b0)
        m.band(b0, b1)
        m.band(b1, w3)
    else:
        m.band(w0, w1)
        m.band(w1, w3)
    # the parapet: out over a lip, a rounded top, down inside to the roof
    pa = 0.07
    tall = 0.35 if variant == 2 else 0.42
    p1 = m.ring(ring(0.08, HUT_H + 0.12, amp=pa), MUD_L)
    p3 = m.ring(ring(-0.06, HUT_H + tall, rc=0.35, amp=pa), MUD_L)
    p4 = m.ring(ring(-0.34, HUT_H + tall - 0.06, rc=0.2, amp=pa), MUD_L)
    p5 = m.ring(ring(-0.36, HUT_H + 0.05, rc=0.2, amp=0.02), MUD)
    m.band(w3, p1)
    m.band(p1, p3)
    m.band(p3, p4)
    m.band(p4, p5)
    m.fan(p5, m.v((0.0, HUT_H + 0.07, 0.0), MUD), up=True)
    if room:
        return m
    if variant == 1:
        # horns: the corners of the parapet drawn up into rounded points
        for sx in (-1, 1):
            for sz in (-1, 1):
                cx, cz = sx * (hx - 0.3), sz * (hz - 0.3)
                ids = m.ring(circle(0.3, HUT_H + tall - 0.05, 4, rot=0.8, cx=cx, cz=cz), MUD_L)
                mid = m.ring(circle(0.18, HUT_H + tall + 0.3, 4, rot=0.8, cx=cx, cz=cz), MUD_L)
                m.band(ids, mid)
                m.fan(mid, m.v((cx, HUT_H + tall + 0.52, cz), MUD_L), up=True)
    if variant == 2:
        # two wooden spouts to throw the rain clear of the wall
        for sx, sz in ((-1, 1), (1, -1)):
            x0 = sx * (hx - 0.9)
            z0 = sz * (hz - 0.1)
            prism(m, (x0, HUT_H + 0.12, z0), (x0, HUT_H + 0.05, z0 + sz * 0.75), 0.09, WOOD, n=4, caps=(False, True), rot=math.pi / 4)
    return m


def hut_door():
    """A plank door between two mud jambs under a log lintel, a sill before it."""
    m = Mesh()
    # the jambs, a little proud of the wall, rounded off at their heads
    for s in (-1, 1):
        box(m, (s * 0.68, 1.0, 0.1), (0.26, 2.0, 0.2), MUD_L, open_back=True, open_bottom=True)
    # the shadow round the leaf, and the leaf of three planks with two battens across
    box(m, (0.0, 0.97, 0.06), (1.12, 1.94, 0.04), DARK, open_back=True, open_bottom=True)
    for i, x in enumerate((-0.37, 0.0, 0.37)):
        box(m, (x, 0.93 + 0.02 * (i % 2), 0.1), (0.35, 1.82 - 0.03 * i, 0.05), WOOD, open_back=True, open_bottom=True)
    for y in (0.45, 1.45):
        box(m, (0.0, y, 0.14), (1.0, 0.12, 0.04), WOOD_D, open_back=True, open_bottom=True)
    # the lintel: one rough log, its ends past the jambs
    prism(m, (-1.0, 2.1, 0.12), (1.02, 2.13, 0.1), 0.13, WOOD_D, n=4, rot=0.3)
    # the sill: a worn step of mud
    box(m, (0.0, 0.07, 0.26), (1.5, 0.16, 0.38), MUD_L, open_back=True, open_bottom=True)
    return m


def hut_window():
    """A small window: a mud surround, the dark of it, a stick lintel and two bars."""
    m = Mesh()
    box(m, (0.0, -0.46, 0.06), (0.86, 0.14, 0.14), MUD_L, open_back=True, open_bottom=True)  # sill
    a, b, c, d = (m.v(p, DARK) for p in ((-0.28, -0.42, 0.04), (0.28, -0.42, 0.04), (0.28, 0.42, 0.04), (-0.28, 0.42, 0.04)))
    m.q(a, b, c, d)
    prism(m, (-0.5, 0.5, 0.08), (0.52, 0.52, 0.08), 0.06, WOOD, n=4, rot=0.4, caps=(False, False))
    for x in (-0.12, 0.12):
        prism(m, (x, -0.4, 0.07), (x, 0.44, 0.07), 0.03, WOOD_D, n=3, caps=(False, False))
    return m


def hut_beam():
    """A roof beam's end, a rough round pole poking a hand or two out of the wall."""
    m = Mesh()
    prism(m, (0.0, 0.0, -0.08), (0.0, -0.03, 0.48), 0.1, WOOD_D, n=4, r1=0.085, caps=(False, True), rot=0.2)
    return m


# ---------------------------------------------------------------- the wind tower

TOWER_H = 10.0


def wind_tower(variant):
    """A tapered shaft, the catchers at its top slatted on every face, a cap and two beams."""
    m = Mesh()
    H = TOWER_H
    top = H - 3.2  # where the catcher begins
    # the shaft
    f0 = m.ring(rrect(1.3, 1.3, 0.18, 1, -1.0), FOOT)
    f1 = m.ring(rrect(1.3, 1.3, 0.18, 1, 0.05), FOOT)
    s0 = m.ring(rrect(1.24, 1.24, 0.16, 1, 0.05), MUD)
    s1 = m.ring(rrect(1.2, 1.2, 0.16, 1, 0.5), MUD)
    s2 = m.ring(rrect(1.12, 1.12, 0.14, 1, 6.0), MUD)
    s3 = m.ring(rrect(1.12, 1.12, 0.14, 1, top), MUD)
    m.band(f0, f1)
    m.band(f1, s0)
    m.band(s0, s1)
    m.band(s1, s2)
    m.band(s2, s3)
    # a moulded ledge where the catcher starts
    l0 = m.ring(rrect(1.24, 1.24, 0.14, 1, top + 0.02), MUD_L)
    l1 = m.ring(rrect(1.24, 1.24, 0.14, 1, top + 0.22), MUD_L)
    m.band(s3, l0)
    m.band(l0, l1)
    m.fan(l1, m.v((0, top + 0.22, 0), MUD_L), up=True)
    # the catcher: the dark of the shaft, corner piers, slats between them on every face
    ch = 2.5
    yb = top + 0.22
    box(m, (0, yb + ch / 2, 0), (1.9, ch, 1.9), DARK, open_bottom=True)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box(m, (sx * 0.97, yb + ch / 2, sz * 0.97), (0.36, ch, 0.36), MUD, open_bottom=True)
    slats = (-0.42, 0.0, 0.42) if variant == 0 else (-0.5, -0.17, 0.17, 0.5)
    for f in range(4):
        a = f * math.pi / 2
        for s in slats:
            c = yaw((s, yb + ch / 2, 1.0), a)
            box(m, c, (0.11, ch, 0.34), MUD_L, ry=a, open_bottom=True, open_back=True)
    # the cap over it, and (variant 1) a stepped crown
    cy = yb + ch
    box(m, (0, cy + 0.15, 0), (2.8, 0.3, 2.8), MUD_L)
    if variant == 0:
        box(m, (0, cy + 0.42, 0), (2.2, 0.26, 2.2), MUD_L, open_bottom=True)
    else:
        for sx in (-1, 1):
            for sz in (-1, 1):
                box(m, (sx * 1.15, cy + 0.5, sz * 1.15), (0.4, 0.42, 0.4), MUD_L, open_bottom=True)
        box(m, (0, cy + 0.36, 0), (2.4, 0.14, 2.4), MUD_L, open_bottom=True)
    # beams through the shaft below the catcher, their ends poking out
    prism(m, (-1.75, H - 3.5, 0.02), (1.75, H - 3.5, -0.02), 0.08, WOOD_D, n=4, rot=0.3)
    prism(m, (0.03, H - 3.8, -1.75), (-0.02, H - 3.8, 1.75), 0.08, WOOD_D, n=4, rot=0.1)
    return m


# ---------------------------------------------------------------- the awning

AWN_W, AWN_D = 4.4, 3.2


def awning(variant):
    """Dyed cloth on four poles, sagging between them, a scalloped valance along the front."""
    m = Mesh()
    hw, hd = AWN_W / 2, AWN_D / 2
    xs = [-hw - 0.25, -hw, -hw / 2, 0, hw / 2, hw, hw + 0.25]
    zs = [-hd - 0.25, -hd, 0, hd, hd + 0.25]

    def y(x, z):
        tx = min(abs(x) / hw, 1.0)
        tz = min(abs(z) / hd, 1.0)
        sag = 0.28 * (1 - tx * tx) * (1 - 0.3 * tz * tz) + 0.12 * (1 - tz * tz) * (1 - 0.4 * tx)
        out = max(abs(x) - hw, 0) + max(abs(z) - hd, 0)
        return 2.55 - sag - out * 0.5 - z * 0.05

    if variant == 0:
        rows = [[(x, y(x, z), z) for x in xs] for z in zs]
        m.grid(rows, CLOTH)
    else:
        # striped: the cloth sewn from lengths running front to back, alternate ones a second shade
        for k in range(len(xs) - 1):
            cols = [[(xs[k], y(xs[k], z), z), (xs[k + 1], y(xs[k + 1], z), z)] for z in zs]
            m.grid(cols, CLOTH if k % 2 == 0 else CLOTH_B)
    # the valance on the front edge
    zf = hd + 0.25
    top = [(x, y(x, zf), zf) for x in xs]
    bot = [(x, y(x, zf) - 0.3, zf + 0.04) for x in xs]
    m.grid([top, bot], CLOTH_B if variant == 0 else CLOTH)
    for sx in (-1, 1):
        for sz in (-1, 1):
            prism(m, (sx * hw, -0.8, sz * hd), (sx * hw, 2.58 - sz * 0.05, sz * hd), 0.055, WOOD, n=4, caps=(False, True))
    # two guy lines off the back poles
    for sx in (-1, 1):
        a = (sx * hw, 2.5, -hd)
        b = (sx * (hw + 0.6), -0.05, -hd - 1.4)
        polyline_tube(m, [a, b], 0.02, ROPE)
    return m


# ---------------------------------------------------------------- the kiln

KILN_R = 3.1


def kiln(variant):
    """A beehive kiln on its footing, its mouth an arch to +x with the fire in it, a chimney."""
    m = Mesh()
    R = KILN_R
    n = 10
    rng = random.Random(70 + variant)
    # footing: a low drum a little wider than the dome
    fr = R * 1.12
    a0 = m.ring(circle(fr, -0.2, n, rot=0.1), FOOT)
    a1 = m.ring(circle(fr, 0.7, n, rot=0.1), FOOT)
    a2 = m.ring(circle(R * 0.98, 0.72, n, rot=0.1), FOOT)
    m.band(a0, a1)
    m.band(a1, a2)
    # the dome: a beehive profile from the footing's top to the chimney
    yc = 0.55 * R
    prof = [(0.98, 0.72), (1.0, 1.2), (0.98, 2.0), (0.9, 2.9), (0.75, 3.9), (0.52, 4.9), (0.3, 5.55)]
    if variant == 1:
        prof = [(0.98, 0.72), (1.0, 1.6), (0.92, 3.0), (0.7, 4.4), (0.42, 5.3), (0.25, 5.7)]
    rings = []
    for i, (k, yy) in enumerate(prof):
        jit = [rng.uniform(-0.025, 0.025) for _ in range(n)] if 0 < i < len(prof) - 1 else None
        rings.append(m.ring(circle(R * k, yy * (yc + 1.42 * R) / 6.0, n, rot=0.1, jit=jit), MUD))
    m.band(a2, rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        m.band(r0, r1)
    # the chimney
    ytop = prof[-1][1] * (yc + 1.42 * R) / 6.0
    cr = R * 0.2
    c0 = m.ring(circle(cr, ytop - 0.1, 6), SOOT)
    c1 = m.ring(circle(cr * 0.92, ytop + 0.55, 6), SOOT)
    c2 = m.ring(circle(cr * 0.6, ytop + 0.55, 6), DARK)
    m.fan(rings[-1], m.v((0, ytop, 0), SOOT), up=True)
    m.band(c0, c1)
    m.band(c1, c2)
    m.fan(c2, m.v((0, ytop + 0.3, 0), DARK), up=True)
    # the mouth: an arch of darker brick standing out from the dome, the fire in its dark
    mx = R * 0.86
    w = R * 0.31
    hgt = 1.9
    def arch(x, hw, top):
        pts = [(x, -0.1, -hw)]
        for i in range(7):
            t = i / 6 * math.pi
            pts.append((x, (top - hw) + math.sin(t) * hw, -math.cos(t) * hw))
        pts.append((x, -0.1, hw))
        return pts

    outer = arch(mx + 0.55, w + 0.24, hgt + 0.26)
    inner = arch(mx + 0.58, w, hgt)
    back = arch(mx - 0.6, w + 0.24, hgt + 0.26)
    oi = m.ring(outer, FOOT)
    ii = m.ring(inner, FOOT)
    bi = m.ring(back, FOOT)
    m.band(oi, ii, closed=False)
    m.band(bi, oi, closed=False)
    # the dark inside the arch and the fire low in it
    di = m.ring([(mx + 0.3, p[1], p[2]) for p in inner], DARK)
    m.band(ii, di, closed=False)
    m.fan(di, m.v((mx + 0.3, 0.6, 0.0), DARK), up=False)
    for k, (dz, hh) in enumerate(((-0.25, 0.75), (0.15, 1.05), (0.4, 0.6))):
        base = [(mx + 0.36, 0.0, dz - 0.18), (mx + 0.5, 0.0, dz), (mx + 0.36, 0.0, dz + 0.18)]
        tip = m.v((mx + 0.42, hh, dz + 0.05 * (k - 1)), FLAME)
        ids = m.ring(base, FLAME)
        m.t(ids[0], ids[1], tip)
        m.t(ids[1], ids[2], tip)
    # variant 1: a buttress ring of rough brick round the dome's foot
    if variant == 1:
        b0 = m.ring(circle(R * 1.05, 0.7, n, rot=0.1), MUD_L)
        b1 = m.ring(circle(R * 1.0, 1.4, n, rot=0.1), MUD_L)
        m.band(b0, b1)
    return m


# ---------------------------------------------------------------- the well


def well(variant):
    """A ring of rough stone, the water dark in it, a frame of poles over it and a bucket."""
    m = Mesh()
    rng = random.Random(90 + variant)
    n = 12
    jo = [rng.uniform(-0.04, 0.05) for _ in range(n)]
    ro, ri = 2.15, 1.3
    o0 = m.ring(circle(ro + 0.05, -0.2, n, jit=jo), STONE)
    o1 = m.ring(circle(ro, 0.55, n, jit=jo), STONE)
    o2 = m.ring([(p[0], p[1] + rng.uniform(-0.06, 0.08), p[2]) for p in circle(ro - 0.08, 1.0, n, jit=jo)], STONE)
    i2 = m.ring([(p[0], p[1] + rng.uniform(-0.05, 0.05), p[2]) for p in circle(ri + 0.05, 1.02, n, rot=0.13)], STONE)
    i1 = m.ring(circle(ri, 0.72, n, rot=0.13), STONE)
    m.band(o0, o1)
    m.band(o1, o2)
    m.band(o2, i2)
    m.band(i2, i1)
    m.fan(i1, m.v((0, 0.72, 0), DARK), up=True)
    # mark the courses with a few proud stones on the outside
    for k in range(5):
        a = k / 5 * TAU + 0.3
        rock(m, (math.cos(a) * (ro - 0.05), 0.3 + 0.32 * (k % 2), math.sin(a) * (ro - 0.05)), 0.34, 0.2, 0.3, STONE, rng, n=4)
    if variant == 0:
        # two forked posts, a beam, a windlass on it with a crank, the rope and the bucket
        for s in (-1, 1):
            prism(m, (s * 1.75, -0.3, 0), (s * 1.75, 2.95, 0), 0.12, WOOD, n=5, r1=0.1, caps=(False, False))
            for f in (-1, 1):
                prism(m, (s * 1.75, 2.95, 0), (s * 1.75, 3.35, f * 0.16), 0.07, WOOD, n=4, caps=(False, True))
        prism(m, (-2.1, 3.1, 0), (2.1, 3.12, 0), 0.1, WOOD_D, n=5)
        prism(m, (-0.7, 2.9, 0), (0.7, 2.9, 0), 0.24, WOOD_D, n=6)
        prism(m, (2.1, 3.1, 0), (2.1, 2.75, 0.02), 0.04, WOOD, n=3, caps=(False, False))
        prism(m, (2.1, 2.75, 0.02), (2.45, 2.75, 0.02), 0.04, WOOD, n=3, caps=(False, True))
        top = (0.2, 2.68, 0.0)
    else:
        # a tripod of poles lashed at the top, a pulley wheel under the lashing
        feet = [(1.85, -0.2, 0.0), (-1.0, -0.2, 1.6), (-1.0, -0.2, -1.6)]
        apex = (0.15, 3.6, 0.0)
        for f in feet:
            prism(m, f, add(apex, mul(norm(sub(apex, f)), 0.25)), 0.1, WOOD, n=5, r1=0.08, caps=(False, True))
        box(m, (0.15, 3.55, 0.0), (0.3, 0.3, 0.3), ROPE)
        wh = m.ring([(0.15 + math.cos(i / 8 * TAU) * 0.28, 3.1 + math.sin(i / 8 * TAU) * 0.28, 0.06) for i in range(8)], WOOD_D)
        wb = m.ring([(0.15 + math.cos(i / 8 * TAU) * 0.28, 3.1 + math.sin(i / 8 * TAU) * 0.28, -0.06) for i in range(8)], WOOD_D)
        m.band(wh, wb)
        m.fan(wh, m.v((0.15, 3.1, 0.06), WOOD_D), up=False)
        m.fan(wb, m.v((0.15, 3.1, -0.06), WOOD_D), up=True)
        top = (0.43, 3.1, 0.0)
    # rope and bucket
    by = 1.45
    prism(m, top, (0.2, by + 0.28, 0.0), 0.02, ROPE, n=3, caps=(False, False))
    b0 = m.ring(circle(0.21, by - 0.2, 7), BUCKET)
    b1 = m.ring(circle(0.27, by + 0.18, 7), BUCKET)
    m.band(b0, b1)
    m.fan(b0, m.v((0, by - 0.2, 0), BUCKET), up=False)
    m.fan(b1, m.v((0, by + 0.08, 0), DARK), up=True)
    # shift the bucket to hang under the rope
    nb = 7 * 2 + 2
    for k in range(len(m.pos) - nb, len(m.pos)):
        p = m.pos[k]
        m.pos[k] = (p[0] + 0.2, p[1], p[2])
    prism(m, (-0.07, by + 0.18, 0.0), (0.2, by + 0.34, 0.0), 0.015, ROPE, n=3, caps=(False, False))
    prism(m, (0.2, by + 0.34, 0.0), (0.47, by + 0.18, 0.0), 0.015, ROPE, n=3, caps=(False, False))
    return m


# ---------------------------------------------------------------- the fire


def fire(variant):
    """A ring of fire stones round crossed logs and the flame between them."""
    m = Mesh()
    rng = random.Random(110 + variant)
    ns = 7
    for i in range(ns):
        a = i / ns * TAU + rng.uniform(-0.1, 0.1)
        rock(m, (math.cos(a), 0.2, math.sin(a)), 0.36, 0.32, 0.3, STONE, rng, n=4)
    # ash in the middle
    ash = m.ring(circle(0.75, 0.04, 6, rot=0.3), DARK)
    m.fan(ash, m.v((0, 0.07, 0), DARK), up=True)
    logs = 3
    for k in range(logs):
        a = k / logs * TAU + 0.4
        if variant == 0:
            p0 = (math.cos(a) * 0.75, 0.08, math.sin(a) * 0.75)
            p1 = (math.cos(a) * 0.05, 0.55, math.sin(a) * 0.05)
        else:
            p0 = (math.cos(a) * 0.85, 0.1, math.sin(a) * 0.85)
            p1 = (-math.cos(a) * 0.15, 0.22, -math.sin(a) * 0.15)
        prism(m, p0, p1, 0.1, WOOD_D, n=3, caps=(False, False), rot=a)
    # the flame: two crossed tongues
    for k in range(2):
        a = k * math.pi / 2 + 0.3
        c, s = math.cos(a), math.sin(a)
        pts = [(-0.38 * c, 0.15, -0.38 * s), (0.0, 0.1, 0.0), (0.38 * c, 0.15, 0.38 * s)]
        mids = [(-0.22 * c, 0.75, -0.22 * s), (0.2 * c, 0.85, 0.2 * s)]
        ids = m.ring(pts, FLAME)
        mi = m.ring(mids, FLAME)
        tip = m.v((0.05 * c, 1.35, 0.05 * s), FLAME)
        m.q(ids[0], ids[1], mi[1], mi[0])
        m.t(ids[1], ids[2], mi[1])
        m.t(mi[0], mi[1], tip)
    return m


# ---------------------------------------------------------------- all of them


def models():
    out = {}
    for i in range(3):
        out[f"Tent{'ABC'[i]}"] = tent(i)
    for i in range(3):
        out[f"HutBody{i}"] = hut_body(i)
    out["HutRoom"] = hut_body(0, room=True)
    out["HutDoor"] = hut_door()
    out["HutWindow"] = hut_window()
    out["HutBeam"] = hut_beam()
    for i in range(2):
        out[f"WindTower{i}"] = wind_tower(i)
    for i in range(2):
        out[f"Awning{i}"] = awning(i)
    for i in range(2):
        out[f"Kiln{i}"] = kiln(i)
    for i in range(2):
        out[f"Well{i}"] = well(i)
    for i in range(2):
        out[f"Fire{i}"] = fire(i)
    return out


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


def export(ms):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, m in ms.items():
        ob = make_mesh(name, m)
        a = ob.data.attributes.new("_part", "FLOAT", "POINT")
        a.data.foreach_set("value", [float(p) for p in m.part])
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

# the stone material's colours, roughly, as it lights them by day
PREVIEW = {
    MUD: (0.74, 0.56, 0.38),
    MUD_L: (0.8, 0.62, 0.43),
    FOOT: (0.62, 0.47, 0.32),
    WOOD: (0.42, 0.28, 0.17),
    WOOD_D: (0.33, 0.22, 0.14),
    DARK: (0.07, 0.05, 0.04),
    CLOTH: (0.72, 0.2, 0.14),
    CLOTH_B: (0.55, 0.14, 0.1),
    FLAME: (1.0, 0.66, 0.25),
    STONE: (0.6, 0.56, 0.52),
    ROPE: (0.66, 0.55, 0.38),
    HAIR: (0.11, 0.085, 0.075),
    HAIR_P: (0.5, 0.38, 0.26),
    HAIR_W: (0.095, 0.075, 0.065),
    SOOT: (0.18, 0.15, 0.13),
    BUCKET: (0.52, 0.37, 0.24),
}


def scene_setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.85, 0.76, 0.62, 1)
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
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.78, 0.63, 0.44, 1)
    bpy.ops.mesh.primitive_plane_add(size=600)
    bpy.context.active_object.data.materials.append(sand)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(48), 0, math.radians(-35))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam, mat


def coloured(name, pos, cols, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in pos], [], [(i, i + 1, i + 2) for i in range(0, len(pos), 3)])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    a = me.attributes.new("col", "FLOAT_COLOR", "CORNER")
    a.data.foreach_set("color", [c for t in cols for c in (*(x ** 2.2 for x in t), 1.0)])
    me.materials.append(mat)
    return ob


def shoot(sc, cam, path, pos, elev=20, az=-30, pad=1.12):
    """Frames the given game-frame points from the given elevation and azimuth (orthographic)."""
    e, a = math.radians(elev), math.radians(az)
    # camera axes in Blender space
    fwd = (-math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), -math.sin(e))
    right = (math.cos(a), math.sin(a), 0.0)
    up = cross(right, fwd)
    bp = [to_blender(p) for p in pos]
    xs = [sum(p[i] * right[i] for i in range(3)) for p in bp]
    ys = [sum(p[i] * up[i] for i in range(3)) for p in bp]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    w = max(max(xs) - min(xs), (max(ys) - min(ys)) * sc.render.resolution_x / sc.render.resolution_y) * pad
    centre = add(mul(right, cx), mul(up, cy))
    cam.data.ortho_scale = w
    cam.data.clip_end = 2000
    cam.location = sub(centre, mul(fwd, 400))
    cam.rotation_euler = (math.radians(90 - elev), 0, a)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def preview(ms, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    sc, cam, mat = scene_setup()
    placed = []
    obs = []

    def place(name, at, rot=0.0, scale=(1, 1, 1)):
        m = ms[name]
        pos, cols = [], []
        for t in m.tri:
            for i in t:
                p = m.pos[i]
                p = yaw((p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]), rot)
                pos.append(add(p, at))
                cols.append(PREVIEW[m.part[t[0]]])
        placed.append(pos)
        ob = coloured(name + "_p", pos, cols, mat)
        obs.append(ob)
        return ob

    def row(names, step, rot=0.0):
        for i, n in enumerate(names):
            x = (i - (len(names) - 1) / 2) * step
            place(n, (x, 0, 0), rot=rot)

    def done(tag, elev=20, az=-30):
        pts = [p for ps in placed for p in ps]
        shoot(sc, cam, os.path.join(out_dir, f"{tag}.png"), pts, elev=elev, az=az)
        for ob in obs:
            bpy.data.objects.remove(ob)
        obs.clear()
        placed.clear()

    row(["TentA", "TentB", "TentC"], 12.0)
    done("tents")
    row(["TentA", "TentC"], 12.0, rot=math.pi)
    done("tents_back")
    row(["HutBody0", "HutBody1", "HutBody2", "HutRoom"], 8.0)
    done("huts")
    # a dressed hut, as the game puts one together: door, two windows, beams, an upper room
    for i, (bx, v) in enumerate(((-4.5, 0), (4.5, 1))):
        place(f"HutBody{v}", (bx, 0, 0))
        place("HutDoor", (bx + 0.6, 0, 2.5))
        place("HutWindow", (bx - 1.6, 1.7, 2.5))
        for k in range(3):
            place("HutBeam", (bx - 2.4 + k * 2.4, 2.75, 2.5))
        if v == 1:
            place("HutRoom", (bx - 0.8, 3.22, -0.5), scale=(0.55, 2.4 / 3.2, 0.6))
    done("huts_dressed", elev=16, az=-24)
    row(["HutDoor", "HutWindow", "HutBeam"], 2.2)
    done("hut_bits", elev=10, az=-20)
    row(["WindTower0", "WindTower1"], 5.0)
    done("towers", elev=14)
    row(["Awning0", "Awning1"], 6.0)
    done("awnings")
    row(["Kiln0", "Kiln1"], 9.0, rot=-math.pi / 2)
    done("kilns", elev=14)
    row(["Well0", "Well1"], 6.0)
    done("wells")
    row(["Fire0", "Fire1"], 3.4)
    done("fires", elev=28)


def scene_points(path):
    """A settlement as the game built it: flat triangles, x y z r g b kind per corner (game frame)."""
    import struct

    with open(path, "rb") as f:
        data = f.read()
    n = len(data) // 28
    pos, col = [], []
    for i in range(n):
        x, y, z, r, g, b, k = struct.unpack_from("<7f", data, i * 28)
        pos.append((x, y, z))
        kk = k % 10
        if kk >= 2.9:
            col.append((1.0, 0.7, 0.3))
        elif kk < 0.5:
            col.append((min(r * 0.62, 1), min(g * 0.58, 1), min(b * 0.54, 1)))
        elif kk < 1.5:
            col.append((min(r * 0.72, 1), min(g * 0.7, 1), min(b * 0.66, 1)))
        else:
            col.append((min(r * 0.8, 1), min(g * 0.66, 1), min(b * 0.52, 1)))
    return pos, col


def render_scene(path, out_png, elev=35, az=-30, crop=0.0):
    sc, cam, mat = scene_setup()
    pos, col = scene_points(path)
    if crop > 0:
        keep = [i for i in range(0, len(pos), 3) if all(math.hypot(pos[i + k][0], pos[i + k][2]) < crop for k in range(3))]
        pos = [pos[i + k] for i in keep for k in range(3)]
        col = [col[i + k] for i in keep for k in range(3)]
    coloured("scene_p", pos, col, mat)
    shoot(sc, cam, out_png, pos, elev=elev, az=az, pad=1.04)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ms = models()
    export(ms)
    for name, m in ms.items():
        print("PIECE", name, "verts", len(m.pos), "tris", len(m.tri))
    print("SETTLEMENTS", OUT, os.path.getsize(OUT), "bytes")
    if "--preview" in argv:
        preview(ms, argv[argv.index("--preview") + 1])
    if "--scene" in argv:
        # --scene IN.bin OUT.png [ELEV AZ CROP]: render a settlement dumped by the game's builder
        i = argv.index("--scene")
        extra = argv[i + 3 : i + 6]
        render_scene(argv[i + 1], argv[i + 2], *(float(x) for x in extra))


if __name__ == "__main__":
    main()
