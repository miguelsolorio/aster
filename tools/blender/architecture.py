"""Hand-made architectural details for the city buildings, exported to public/art/architecture.glb.

    blender --background --python tools/blender/architecture.py                   # write the .glb
    blender --background --python tools/blender/architecture.py -- --preview DIR  # and render the kit and a facade

Built in the game's own frame (metres, +Y up) and turned into Blender's Z-up frame only when the
mesh is made, so the exporter's +Y-up conversion gives back exactly these numbers. No materials,
no normals (the game works them out from the winding; hard edges are split vertices), all
triangles wound outward.

Every piece is drawn in the frame of the wall it is set into: x along the wall, y up, z out of the
wall (z 0 is the wall's face). src/city/build.ts stamps them where it already knows the openings
and edges are, scaling each axis to the opening (the reference sizes below), and keeps them in a
mesh of their own, so the masonry (and the collision worked out from it) never changes.

  DoorLeaf0..2   carved door in the back of a door hole: x -0.5..0.5, y 0..2.3, z 0..0.08
                 (z 0 the hole's back); scaled to the hole. 0 studded double door, 1 panelled,
                 2 planked with iron straps and a ring
  DoorFrame0..1  surround of a flat-topped door, origin at the foot of the opening on the wall,
                 opening x -0.5..0.5, y 0..2.3 (scaled with it). 0 stepped plaster surround, wooden
                 lintel and stone threshold; 1 timber posts, lintel on brackets, plaster panel
  DoorArch0      ring round an arch of width 1 and rise 0.5 (pointed 0.3), origin at the middle of
                 the springing line; scaled uniformly by the door's width. Keystone at the crown
  DoorJamb0      the jambs under it, y 0..1 (scaled to the springing height)
  Win0..2        window fittings, origin at the middle of the sill on the wall, opening x -0.35..0.35,
                 y 0..1.1 (scaled to it): a frame set 2 cm into the reveal (the dark back of the
                 opening, which glows at night, shows through), a sill and 0 a lattice screen and
                 lintel, 1 open louvred shutters against the wall, 2 a grille under a small hood.
                 Nothing comes more than 0.13 out of the wall (the window glow sits 0.15 out)
  Spout0..1      wooden drainage spout round the procedural one (x -0.1..0.1, y -0.14..0, z 0..0.75),
                 origin at the middle of its top on the wall: an open trough with the box as its floor
  Viga0..1       a roof beam end round the procedural one (x -0.11..0.11, y 0..0.22), z 0..1 scaled
                 to its length: a hewn six-sided log with its end grain
  MerlonCap0     stepped cap on a merlon 0.9 long, 0.3 thick (z -0.3..0), origin at its top middle
  ParapetStep0   stepped crenel on a parapet coping 0.3 thick (z -0.3..0), origin at the coping
  ParapetTooth0  the adobe version: a soft tapered tooth
  CornerCap0     stepped cap on a 0.65 square corner block, origin at its top middle
  DomeRing0      one straight piece of the moulding round a drum's top, x -0.5..0.5 (scaled to the
                 side), y -0.2..0.05 about the drum's top edge, z 0..0.12 out of the drum
  DomeLantern0   a small open lantern for the crown of a round dome, base at y 0, 1.15 tall
  DomeFinial0    stacked bulbs round the needle of a pointed dome, base at y 0, 0.5 tall

Every vertex carries
  _info (vec3)  x the masonry material id (0 plaster, 2 stone, 3 wood, 4 dark opening/iron,
                7 lantern glass), or -1 for the host's own material (the building's wall, or the
                spout's wood or stone); y the tint: for -1 a signed offset (added to the host's
                tint), else 0..1; z the wood's baked hue seed 0..1 (0 the shader's own wood)
  _grain (vec2) texture coordinates 0..1 across each face, as the procedural boxes have them, so
                the wood shader runs its grain along the member.
"""

import math
import os
import sys

import bpy

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "architecture.glb"))

HOST, PLASTER, ROOF, STONE, WOOD, OPENING, LANTERN, DOME = -1, 0, 1, 2, 3, 4, 7, 9

DOOR_W, DOOR_H = 1.0, 2.3
WIN_W, WIN_H = 0.7, 1.1

BUDGET = {"DoorLeaf": 60, "DoorFrame": 60, "DoorArch": 46, "DoorJamb": 12, "Win": 80, "Spout": 24,
          "Viga": 16, "MerlonCap": 24, "ParapetStep": 30, "ParapetTooth": 12, "CornerCap": 14,
          "DomeRing": 6, "DomeLantern": 120, "DomeFinial": 60}
# a door set is a leaf and its surround: flat frame, or arch ring and jambs
DOOR_SET = 120


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


class Mesh:
    def __init__(self):
        self.pos = []
        self.info = []
        self.uv = []
        self.tri = []

    def v(self, p, mat, tint=0.0, hue=0.0, uv=(0.5, 0.5)):
        self.pos.append(tuple(float(c) for c in p))
        self.info.append((float(mat), float(tint), float(hue)))
        self.uv.append(uv)
        return len(self.pos) - 1

    def t(self, a, b, c, hint):
        pa, pb, pc = self.pos[a], self.pos[b], self.pos[c]
        if dot(cross(sub(pb, pa), sub(pc, pa)), hint) < 0:
            b, c = c, b
        self.tri.append((a, b, c))

    def face(self, pts, mat, tint, hint, hue=0.0, uvs=None):
        """A flat convex polygon of its own vertices (a hard edge all round), wound to face hint."""
        if uvs is None:
            uvs = [(0, 0), (1, 0), (1, 1), (0, 1)] if len(pts) == 4 else [(0.5, 0.5)] * len(pts)
        ids = [self.v(p, mat, tint, hue, uv) for p, uv in zip(pts, uvs)]
        for k in range(1, len(ids) - 1):
            self.t(ids[0], ids[k], ids[k + 1], hint)

    def box(self, x0, y0, z0, x1, y1, z1, mat, tint, hue=0.0, skip=("-z",)):
        """Axis box; skip names the faces left out (by default its back, against the wall)."""
        P = lambda sx, sy, sz: (x1 if sx > 0 else x0, y1 if sy > 0 else y0, z1 if sz > 0 else z0)
        faces = {
            "+x": ([P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1)], (1, 0, 0)),
            "-x": ([P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1)], (-1, 0, 0)),
            "+y": ([P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)], (0, 1, 0)),
            "-y": ([P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1)], (0, -1, 0)),
            "+z": ([P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], (0, 0, 1)),
            "-z": ([P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], (0, 0, -1)),
        }
        for k, (pts, n) in faces.items():
            if k not in skip:
                self.face(pts, mat, tint, n, hue)

    def pyramid(self, x0, z0, x1, z1, y, apex, mat, tint, hue=0.0):
        c = ((x0 + x1) / 2, (z0 + z1) / 2)
        corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
        for k in range(4):
            a, b = corners[k], corners[(k + 1) % 4]
            mid = ((a[0] + b[0]) / 2 - c[0], 0.3, (a[1] + b[1]) / 2 - c[1])
            self.face([(a[0], y, a[1]), (b[0], y, b[1]), apex], mat, tint, mid, hue)

    def tris(self):
        return len(self.tri)

    def extend(self, other):
        o = len(self.pos)
        self.pos += other.pos
        self.info += other.info
        self.uv += other.uv
        self.tri += [(a + o, b + o, c + o) for a, b, c in other.tri]


def prism(m, cx, cy, cz, rs, y0, y1, sides, mat, tint, hue=0.0, rot=0.0, cap=False):
    """Faceted vertical prism (or frustum, rs a pair) from y0 to y1, flat sides, optional top cap."""
    r0, r1 = rs if isinstance(rs, tuple) else (rs, rs)
    for k in range(sides):
        a0, a1 = rot + k / sides * TAU, rot + (k + 1) / sides * TAU
        am = (a0 + a1) / 2
        pts = [(cx + math.cos(a0) * r0, cy + y0, cz + math.sin(a0) * r0), (cx + math.cos(a1) * r0, cy + y0, cz + math.sin(a1) * r0),
               (cx + math.cos(a1) * r1, cy + y1, cz + math.sin(a1) * r1), (cx + math.cos(a0) * r1, cy + y1, cz + math.sin(a0) * r1)]
        slope = (r0 - r1) / max(1e-6, y1 - y0)
        hint = (math.cos(am), slope, math.sin(am))
        if r1 < 1e-4:
            m.face([pts[0], pts[1], pts[2]], mat, tint, hint, hue)
        else:
            m.face(pts, mat, tint, hint, hue)
    if cap and r1 > 1e-4:
        ring = [(cx + math.cos(rot + k / sides * TAU) * r1, cy + y1, cz + math.sin(rot + k / sides * TAU) * r1) for k in range(sides)]
        m.face(ring, mat, tint, (0, 1, 0), hue)


def lathe(m, profile, sides, mat, tint, hue=0.0, rot=0.0):
    """A turned shape from (r, y) pairs, bottom up, flat-shaded bands; r 0 at the ends closes it."""
    for (ra, ya), (rb, yb) in zip(profile, profile[1:]):
        for k in range(sides):
            a0, a1 = rot + k / sides * TAU, rot + (k + 1) / sides * TAU
            am = (a0 + a1) / 2
            P = lambda r, y, a: (math.cos(a) * r, y, math.sin(a) * r)
            hint = (math.cos(am) * (yb - ya), ra - rb, math.sin(am) * (yb - ya))
            if abs(yb - ya) < 1e-6:
                hint = (0, 1 if rb < ra else -1, 0)
            pts = [P(ra, ya, a0), P(ra, ya, a1), P(rb, yb, a1), P(rb, yb, a0)]
            if ra < 1e-4:
                m.face([pts[0], pts[2], pts[3]], mat, tint, hint, hue)
            elif rb < 1e-4:
                m.face([pts[0], pts[1], pts[2]], mat, tint, hint, hue)
            else:
                m.face(pts, mat, tint, hint, hue)


# ---------------------------------------------------------------- doors

HW = DOOR_W / 2


def planks(m, x0, x1, n, z_hi, z_lo, y0, y1, tint, hue):
    """n vertical planks between x0 and x1, every other one set back a little, with the steps between."""
    w = (x1 - x0) / n
    zs = [z_hi if k % 2 == 0 else z_lo for k in range(n)]
    for k in range(n):
        a, b = x0 + k * w, x0 + (k + 1) * w
        z = zs[k]
        # a plank's own shade: the boards of one door are never quite alike
        t = tint + (0.08 if k % 3 == 1 else -0.05 if k % 3 == 2 else 0.0)
        m.face([(a, y0, z), (b, y0, z), (b, y1, z), (a, y1, z)], WOOD, t, (0, 0, 1), hue)
        if k + 1 < n and zs[k + 1] != z:
            hi, lo = max(z, zs[k + 1]), min(z, zs[k + 1])
            # the step faces the lower plank
            m.face([(b, y0, lo), (b, y0, hi), (b, y1, hi), (b, y1, lo)], WOOD, t, (1 if z > zs[k + 1] else -1, 0, 0), hue)


def studs(m, x, y, z, s=0.042, h=0.032):
    """An iron nail head: a low four-sided pyramid standing out of the door face."""
    c = [(x - s, y - s), (x + s, y - s), (x + s, y + s), (x - s, y + s)]
    apex = (x, y, z + h)
    for k in range(4):
        a, b = c[k], c[(k + 1) % 4]
        hint = ((a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y, 0.6)
        m.face([(a[0], a[1], z), (b[0], b[1], z), apex], OPENING, 0.0, hint)


def door_leaf(i):
    m = Mesh()
    H = DOOR_H
    if i == 0:
        # studded double door of warm boards, the leaves meeting behind a batten
        hue, tint = 0.82, 0.42
        for s in (-1, 1):
            xa, xb = (-HW, -0.012) if s < 0 else (0.012, HW)
            planks(m, xa, xb, 3, 0.05, 0.042, 0.0, H, tint, hue)
        m.box(-0.032, 0.0, 0.05, 0.032, H, 0.076, WOOD, tint - 0.1, hue, skip=("-z", "-y", "+y"))
        for y in (0.78, 1.62):
            for x in (-0.33, -0.16, 0.16, 0.33):
                studs(m, x, y, 0.05)
    elif i == 1:
        # panelled door, two by two, of grey weathered wood
        hue, tint, z, zp, bev = 0.04, 0.55, 0.05, 0.028, 0.035
        cols = [(-0.4, -0.04), (0.04, 0.4)]
        rows = [(0.24, 1.02), (1.22, 2.08)]
        rails = [(0.0, 0.24), (1.02, 1.22), (2.08, H)]
        for y0, y1 in rails:
            m.face([(-HW, y0, z), (HW, y0, z), (HW, y1, z), (-HW, y1, z)], WOOD, tint, (0, 0, 1), hue)
        for y0, y1 in rows:
            for x0, x1 in [(-HW, -0.4), (-0.04, 0.04), (0.4, HW)]:
                m.face([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], WOOD, tint, (0, 0, 1), hue)
            for x0, x1 in cols:
                o = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
                n = [(x0 + bev, y0 + bev, zp), (x1 - bev, y0 + bev, zp), (x1 - bev, y1 - bev, zp), (x0 + bev, y1 - bev, zp)]
                hints = [(0, 1, 1), (-1, 0, 1), (0, -1, 1), (1, 0, 1)]
                for k in range(4):
                    m.face([o[k], o[(k + 1) % 4], n[(k + 1) % 4], n[k]], WOOD, tint + 0.12, hints[k], hue)
                m.face(n, WOOD, tint - 0.06, (0, 0, 1), hue)
    else:
        # planked door with three iron straps and a ring to knock with
        hue, tint = 0.38, 0.38
        planks(m, -HW, HW, 5, 0.05, 0.043, 0.0, H, tint, hue)
        for y in (0.36, 1.16, 1.98):
            m.box(-HW, y, 0.05, HW, y + 0.07, 0.063, OPENING, 0.0, skip=("-z", "-x", "+x"))
        cx, cy, r0, r1, z = 0.22, 1.08, 0.055, 0.085, 0.066
        for k in range(8):
            a0, a1 = k / 8 * TAU, (k + 1) / 8 * TAU
            pts = [(cx + math.cos(a0) * r0, cy + math.sin(a0) * r0 - r1, z), (cx + math.cos(a1) * r0, cy + math.sin(a1) * r0 - r1, z),
                   (cx + math.cos(a1) * r1, cy + math.sin(a1) * r1 - r1, z), (cx + math.cos(a0) * r1, cy + math.sin(a0) * r1 - r1, z)]
            m.face(pts, OPENING, 0.0, (0, 0, 1))
    return m


def door_frame(i):
    m = Mesh()
    H = DOOR_H
    if i == 0:
        # a stepped plaster surround, a wooden lintel over it and a stone threshold
        for s in (-1, 1):
            xo, xi = s * (HW + 0.24), s * HW
            m.box(min(xo, xi), 0.0, 0.0, max(xo, xi), H, 0.035, HOST, 0.05, skip=("-z", "-y", "+y"))
            xo = s * (HW + 0.12)
            m.box(min(xo, xi), 0.0, 0.035, max(xo, xi), H, 0.07, HOST, 0.09, skip=("-z", "-y", "+y"))
        m.box(-HW - 0.36, H, 0.0, HW + 0.36, H + 0.2, 0.13, WOOD, 0.35, 0.5)
        m.box(-HW - 0.24, H + 0.2, 0.0, HW + 0.24, H + 0.3, 0.035, HOST, 0.05, skip=("-z", "-y"))
        m.box(-HW - 0.16, -0.06, 0.0, HW + 0.16, 0.08, 0.26, STONE, 0.55, skip=("-z", "-y"))
    else:
        # timber door case: posts, a heavy lintel on two brackets, a plaster panel above
        hue = 0.3
        for s in (-1, 1):
            xo, xi = s * (HW + 0.15), s * HW
            m.box(min(xo, xi), 0.0, 0.0, max(xo, xi), H, 0.1, WOOD, 0.3, hue, skip=("-z", "-y", "+y"))
            # bracket: a block under the lintel, its lower front cut back
            xa, xb = sorted((s * (HW + 0.15), s * (HW + 0.36)))
            yb, yt, zt = H - 0.2, H, 0.13
            m.face([(xa, yt, zt), (xb, yt, zt), (xb, yb + 0.1, zt * 0.45), (xa, yb + 0.1, zt * 0.45)], WOOD, 0.42, (0, -0.4, 1), hue)
            m.face([(xa, yb + 0.1, zt * 0.45), (xb, yb + 0.1, zt * 0.45), (xb, yb, 0.0), (xa, yb, 0.0)], WOOD, 0.42, (0, -1, 0.3), hue)
            xs = xb if s > 0 else xa
            m.face([(xs, yt, 0.0), (xs, yt, zt), (xs, yb + 0.1, zt * 0.45), (xs, yb, 0.0)], WOOD, 0.42, (s, 0, 0), hue)
        m.box(-HW - 0.45, H, 0.0, HW + 0.45, H + 0.24, 0.16, WOOD, 0.25, hue)
        for s in (-1, 1):
            x = s * (HW + 0.07)
            m.face([(x - 0.035, H + 0.085, 0.162), (x + 0.035, H + 0.085, 0.162), (x + 0.035, H + 0.155, 0.162), (x - 0.035, H + 0.155, 0.162)],
                   OPENING, 0.0, (0, 0, 1))
        m.box(-HW - 0.2, H + 0.24, 0.0, HW + 0.2, H + 0.56, 0.03, HOST, 0.07, skip=("-z", "-y"))
        m.box(-HW - 0.12, -0.06, 0.0, HW + 0.12, 0.07, 0.24, STONE, 0.5, skip=("-z", "-y"))
    return m


def arch_curve(hw, rise, p, K):
    us, ys = [], []
    for i in range(2 * K + 1):
        left = i <= K
        q = i / K if left else (2 * K - i) / K
        a = q * math.pi * 0.5
        du = hw * ((1 - p) * (1 - math.cos(a)) + p * q)
        ys.append(rise * ((1 - p) * math.sin(a) + p * q))
        us.append(-hw + du if left else hw - du)
    us[K], ys[K] = 0.0, rise
    return us, ys


def door_arch():
    """A plaster ring round the arch, standing 4 cm off the wall, with a keystone."""
    m = Mesh()
    K, band, z = 3, 0.13, 0.04
    iu, iy = arch_curve(0.5, 0.5, 0.3, K)
    ou, oy = [], []
    for u, y in zip(iu, iy):
        l = math.hypot(u, y) or 1
        ou.append(u + u / l * band)
        oy.append(y + y / l * band)
    for k in range(2 * K):
        a, b = k, k + 1
        m.face([(iu[a], iy[a], z), (iu[b], iy[b], z), (ou[b], oy[b], z), (ou[a], oy[a], z)], HOST, 0.07, (0, 0, 1))
        mo = ((ou[a] + ou[b]) / 2, (oy[a] + oy[b]) / 2)
        m.face([(ou[a], oy[a], 0), (ou[b], oy[b], 0), (ou[b], oy[b], z), (ou[a], oy[a], z)], HOST, 0.07, (mo[0], mo[1], 0))
        mi = ((iu[a] + iu[b]) / 2, (iy[a] + iy[b]) / 2)
        m.face([(iu[a], iy[a], 0), (iu[b], iy[b], 0), (iu[b], iy[b], z), (iu[a], iy[a], z)], HOST, 0.03, (-mi[0], -mi[1], 0))
    m.box(-0.075, 0.44, 0.0, 0.075, 0.5 + band + 0.07, 0.075, HOST, 0.12, skip=("-z", "-y"))
    return m


def door_jamb():
    m = Mesh()
    for s in (-1, 1):
        xo, xi = s * (HW + 0.13), s * HW
        m.box(min(xo, xi), 0.0, 0.0, max(xo, xi), 1.0, 0.04, HOST, 0.07, skip=("-z", "-y", "+y"))
    return m


# ---------------------------------------------------------------- windows

WH, WT = WIN_W / 2, WIN_H


def win_frame(m, hue):
    """A wooden frame 2 cm into the reveal, its inner edges running back to 5 cm."""
    f, z, zb = 0.06, -0.02, -0.05
    bars = [(-WH, 0, -WH + f, WT), (WH - f, 0, WH, WT), (-WH + f, 0, WH - f, f), (-WH + f, WT - f, WH - f, WT)]
    for x0, y0, x1, y1 in bars:
        m.face([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], WOOD, 0.4, (0, 0, 1), hue)
    xi0, xi1, yi0, yi1 = -WH + f, WH - f, f, WT - f
    m.face([(xi0, yi0, zb), (xi0, yi0, z), (xi0, yi1, z), (xi0, yi1, zb)], WOOD, 0.55, (1, 0, 0), hue)
    m.face([(xi1, yi0, zb), (xi1, yi0, z), (xi1, yi1, z), (xi1, yi1, zb)], WOOD, 0.55, (-1, 0, 0), hue)
    m.face([(xi0, yi0, zb), (xi1, yi0, zb), (xi1, yi0, z), (xi0, yi0, z)], WOOD, 0.65, (0, 1, 0), hue)
    m.face([(xi0, yi1, zb), (xi1, yi1, zb), (xi1, yi1, z), (xi0, yi1, z)], WOOD, 0.3, (0, -1, 0), hue)


def win_sill(m, mat=HOST):
    m.box(-WH - 0.07, -0.07, 0.0, WH + 0.07, 0.0, 0.07, mat, 0.08 if mat == HOST else 0.5)


def window(i):
    m = Mesh()
    if i == 0:
        # a lattice screen of thin laths, the uprights over the rails, under a wooden lintel
        hue = 0.55
        win_frame(m, hue)
        x0, x1, y0, y1 = -WH + 0.06, WH - 0.06, 0.06, WT - 0.06
        for k in range(1, 5):
            x = x0 + (x1 - x0) * k / 5
            m.face([(x - 0.016, y0, -0.036), (x + 0.016, y0, -0.036), (x + 0.016, y1, -0.036), (x - 0.016, y1, -0.036)], WOOD, 0.45, (0, 0, 1), hue)
        for k in range(1, 6):
            y = y0 + (y1 - y0) * k / 6
            m.face([(x0, y - 0.016, -0.042), (x1, y - 0.016, -0.042), (x1, y + 0.016, -0.042), (x0, y + 0.016, -0.042)], WOOD, 0.35, (0, 0, 1), hue)
            m.face([(x0, y + 0.016, -0.05), (x1, y + 0.016, -0.05), (x1, y + 0.016, -0.042), (x0, y + 0.016, -0.042)], WOOD, 0.6, (0, 1, 0), hue)
        win_sill(m)
        m.box(-WH - 0.09, WT, 0.0, WH + 0.09, WT + 0.09, 0.05, WOOD, 0.3, hue)
    elif i == 1:
        # a plain frame with its two louvred shutters folded back against the wall
        hue = 0.12
        win_frame(m, 0.5)
        win_sill(m)
        for s in (-1, 1):
            xa, xb = sorted((s * (WH + 0.01), s * (WH + 0.35)))
            y0, y1, z0, z1 = 0.02, WT - 0.02, 0.006, 0.034
            m.box(xa, y0, z0, xb, y1, z1, WOOD, 0.5, hue, skip=("-z",))
            for k in range(3):
                y = y0 + 0.2 + k * 0.3
                m.face([(xa + 0.04, y, z1 + 0.012), (xb - 0.04, y, z1 + 0.012), (xb - 0.04, y + 0.06, z1), (xa + 0.04, y + 0.06, z1)],
                       WOOD, 0.65, (0, 0.5, 1), hue)
                m.face([(xa + 0.04, y, z1), (xb - 0.04, y, z1), (xb - 0.04, y, z1 + 0.012), (xa + 0.04, y, z1 + 0.012)], WOOD, 0.25, (0, -1, 0), hue)
    else:
        # an iron grille of square bars set on edge, a stone sill and a little wooden hood on brackets
        hue = 0.66
        win_frame(m, hue)
        y0, y1, z = 0.06, WT - 0.06, -0.035
        for x in (-0.15, 0.0, 0.15):
            r = 0.022
            m.face([(x - r, y0, z), (x, y0, z + r), (x, y1, z + r), (x - r, y1, z)], OPENING, 0.0, (-1, 0, 1))
            m.face([(x, y0, z + r), (x + r, y0, z), (x + r, y1, z), (x, y1, z + r)], OPENING, 0.0, (1, 0, 1))
        for y in (0.38, 0.78):
            m.face([(-WH + 0.06, y - 0.018, -0.03), (WH - 0.06, y - 0.018, -0.03), (WH - 0.06, y + 0.018, -0.03), (-WH + 0.06, y + 0.018, -0.03)],
                   OPENING, 0.0, (0, 0, 1))
            m.face([(-WH + 0.06, y + 0.018, -0.05), (WH - 0.06, y + 0.018, -0.05), (WH - 0.06, y + 0.018, -0.03), (-WH + 0.06, y + 0.018, -0.03)],
                   OPENING, 0.0, (0, 1, 0))
        win_sill(m, STONE)
        xa, xb, yt, yf, zf = -WH - 0.12, WH + 0.12, WT + 0.17, WT + 0.11, 0.13
        m.face([(xa, yt, 0.0), (xb, yt, 0.0), (xb, yf, zf), (xa, yf, zf)], WOOD, 0.5, (0, 1, 0.6), hue)
        m.face([(xa, yf, zf), (xb, yf, zf), (xb, yf - 0.035, zf), (xa, yf - 0.035, zf)], WOOD, 0.3, (0, 0, 1), hue)
        m.face([(xa, yt - 0.035, 0.0), (xb, yt - 0.035, 0.0), (xb, yf - 0.035, zf), (xa, yf - 0.035, zf)], WOOD, 0.2, (0, -1, 0.3), hue)
        for s, x in ((-1, xa), (1, xb)):
            m.face([(x, yt, 0.0), (x, yf, zf), (x, yf - 0.035, zf), (x, yt - 0.035, 0.0)], WOOD, 0.4, (s, 0, 0), hue)
        for x in (-WH - 0.05, WH + 0.05):
            m.face([(x, yt - 0.035, 0.0), (x, yt - 0.035, zf * 0.85), (x, WT + 0.0, 0.0)], WOOD, 0.35, (1, 0, 0), hue)
            m.face([(x, yt - 0.035, 0.0), (x, yt - 0.035, zf * 0.85), (x, WT + 0.0, 0.0)], WOOD, 0.35, (-1, 0, 0), hue)
    return m


# ---------------------------------------------------------------- roof line


def spout(i):
    """An open trough round the procedural spout box (x -0.1..0.1, y -0.14..0, z 0..0.75)."""
    m = Mesh()
    hue = 0.62
    w0 = 0.128  # half width at the wall
    w1 = 0.128 if i == 0 else 0.112  # at the tip (a tapered one is carved down toward its lip)
    yb0, yb1 = -0.17, (-0.17 if i == 0 else -0.148)
    zt = 0.8 if i == 0 else 0.86
    rim = 0.045
    # outer sides and bottom
    for s in (-1, 1):
        m.face([(s * w0, yb0, 0.0), (s * w1, yb1, zt), (s * w1, rim, zt), (s * w0, rim, 0.0)], HOST, -0.03, (s, 0, 0), hue)
    m.face([(-w0, yb0, 0.0), (w0, yb0, 0.0), (w1, yb1, zt), (-w1, yb1, zt)], HOST, -0.12, (0, -1, 0), hue)
    # rims, and the inner sides down to the box's top (the trough's floor)
    for s in (-1, 1):
        wi0, wi1 = 0.1, 0.1 - (w0 - w1)
        m.face([(s * wi0, rim, 0.0), (s * w0, rim, 0.0), (s * w1, rim, zt), (s * wi1, rim, zt)], HOST, 0.1, (0, 1, 0), hue)
        m.face([(s * wi0, 0.0, 0.0), (s * wi1, 0.0, zt), (s * wi1, rim, zt), (s * wi0, rim, 0.0)], HOST, -0.08, (-s, 0, 0), hue)
    # the end: under the floor full width, and the two rim walls above it
    wi1 = 0.1 - (w0 - w1)
    m.face([(-w1, yb1, zt), (w1, yb1, zt), (w1, 0.0, zt), (-w1, 0.0, zt)], HOST, 0.04, (0, 0, 1), hue)
    for s in (-1, 1):
        xa, xb = sorted((s * wi1, s * w1))
        m.face([(xa, 0.0, zt), (xb, 0.0, zt), (xb, rim, zt), (xa, rim, zt)], HOST, 0.04, (0, 0, 1), hue)
    if i == 1:
        # the floor carries on past the box to a lip
        m.face([(-wi1, 0.0, 0.75), (wi1, 0.0, 0.75), (wi1, 0.0, zt), (-wi1, 0.0, zt)], HOST, -0.15, (0, 1, 0), hue)
    return m


def viga(i):
    """A beam end round the procedural one (x -0.11..0.11, y 0..0.22): a hewn hexagonal log."""
    m = Mesh()
    cy, R = 0.11, 0.18
    hue, tint = (0.5, 0.36) if i == 0 else (0.22, 0.3)
    jit = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0] if i == 0 else [1.08, 1.0, 1.12, 1.03, 1.1, 1.0]
    tip = [1.0] * 6 if i == 0 else [0.985, 1.0, 0.97, 0.99, 1.0, 0.975]
    ring0, ring1 = [], []
    for k in range(6):
        a = k / 6 * TAU
        r = R * jit[k]
        ring0.append((math.cos(a) * r, cy + math.sin(a) * r, -0.01))
        ring1.append((math.cos(a) * r * 0.96, cy + math.sin(a) * r * 0.96, tip[k]))
    for k in range(6):
        j = (k + 1) % 6
        am = (k + 0.5) / 6 * TAU
        t = tint + (0.08 if k in (1, 2) else -0.06 if k in (4, 5) else 0)
        m.face([ring0[k], ring0[j], ring1[j], ring1[k]], WOOD, t, (math.cos(am), math.sin(am), 0), hue)
    m.face(ring1, WOOD, tint + 0.35, (0, 0, 1), hue * 0.5 + 0.35)
    return m


# ---------------------------------------------------------------- parapets


def merlon_cap():
    m = Mesh()
    m.box(-0.48, 0.0, -0.33, 0.48, 0.07, 0.03, HOST, 0.06, skip=("-y",))
    m.box(-0.32, 0.07, -0.26, 0.32, 0.15, -0.04, HOST, 0.1, skip=("-y",))
    m.pyramid(-0.17, -0.235, 0.17, -0.065, 0.15, (0.0, 0.3, -0.15), HOST, 0.12)
    return m


def parapet_step():
    m = Mesh()
    tiers = [(0.32, 0.0, 0.13), (0.2, 0.13, 0.26), (0.09, 0.26, 0.38)]
    for k, (hw, y0, y1) in enumerate(tiers):
        m.box(-hw, y0, -0.27, hw, y1, -0.03, HOST, 0.04 + 0.03 * k, skip=("-y",))
    return m


def parapet_tooth():
    """A soft tapered adobe tooth: a four-sided frustum with a flat, slightly narrow top."""
    m = Mesh()
    b, t, y0, y1 = (0.24, 0.13), (0.1, 0.06), -0.06, 0.34
    cz = -0.15
    lo = [(-b[0], y0, cz - b[1]), (b[0], y0, cz - b[1]), (b[0], y0, cz + b[1]), (-b[0], y0, cz + b[1])]
    hi = [(-t[0], y1, cz - t[1]), (t[0], y1, cz - t[1]), (t[0], y1, cz + t[1]), (-t[0], y1, cz + t[1])]
    hints = [(0, 0.4, -1), (1, 0.4, 0), (0, 0.4, 1), (-1, 0.4, 0)]
    for k in range(4):
        j = (k + 1) % 4
        m.face([lo[k], lo[j], hi[j], hi[k]], HOST, 0.05, hints[k])
    m.face(hi, HOST, 0.1, (0, 1, 0))
    return m


def corner_cap():
    m = Mesh()
    m.box(-0.37, 0.0, -0.37, 0.37, 0.08, 0.37, HOST, 0.06, skip=("-y",))
    m.pyramid(-0.25, -0.25, 0.25, 0.25, 0.08, (0.0, 0.28, 0.0), HOST, 0.1)
    return m


# ---------------------------------------------------------------- domes


def dome_ring():
    """One straight piece of a roll moulding round a drum's top edge (y 0 the edge, z out)."""
    m = Mesh()
    prof = [(-0.2, 0.0), (-0.12, 0.085), (-0.02, 0.12), (0.05, 0.0)]
    tints = [0.02, 0.1, 0.14]
    for k in range(3):
        (ya, za), (yb, zb) = prof[k], prof[k + 1]
        # the profile runs up and out from the drum, so (0, -dz, dy) is the outward side of each facet
        n = (0, -(zb - za), yb - ya)
        m.face([(-0.5, ya, za), (0.5, ya, za), (0.5, yb, zb), (-0.5, yb, zb)], HOST, tints[k], n)
    return m


def dome_lantern():
    m = Mesh()
    hue = 0.3
    # a low six-sided base sunk into the crown, four posts round a dark core, an eave, a cap, a finial
    prism(m, 0, 0, 0, (0.32, 0.3), -0.08, 0.14, 6, HOST, 0.06)
    for k in range(4):
        a = (k + 0.5) / 4 * TAU
        x, z = math.cos(a) * 0.21, math.sin(a) * 0.21
        prism(m, x, 0, z, 0.045, 0.14, 0.64, 4, WOOD, 0.4, hue, rot=a + math.pi / 4)
    prism(m, 0, 0, 0, 0.15, 0.14, 0.64, 6, OPENING, 0.0)
    prism(m, 0, 0, 0, (0.3, 0.37), 0.64, 0.72, 6, HOST, 0.1)
    prism(m, 0, 0, 0, (0.37, 0.0), 0.72, 0.98, 6, HOST, 0.04)
    yc, r = 1.05, 0.065
    P = [(r, 0), (0, r), (-r, 0), (0, -r)]
    for k in range(4):
        a, b = P[k], P[(k + 1) % 4]
        hx, hz = a[0] + b[0], a[1] + b[1]
        m.face([(a[0], yc, a[1]), (b[0], yc, b[1]), (0, yc + r * 1.3, 0)], STONE, 0.6, (hx, 0.5, hz))
        m.face([(a[0], yc, a[1]), (b[0], yc, b[1]), (0, yc - r * 1.2, 0)], STONE, 0.6, (hx, -0.5, hz))
    prism(m, 0, 0, 0, (0.025, 0.0), yc + r * 1.2, 1.18, 4, STONE, 0.5, rot=math.pi / 4)
    return m


def dome_finial():
    m = Mesh()
    lathe(m, [(0.1, 0.0), (0.15, 0.08), (0.07, 0.18), (0.11, 0.27), (0.04, 0.37), (0.0, 0.5)], 6, STONE, 0.55)
    return m


# ---------------------------------------------------------------- the set


def models():
    out = {}
    for i in range(3):
        out[f"DoorLeaf{i}"] = door_leaf(i)
    for i in range(2):
        out[f"DoorFrame{i}"] = door_frame(i)
    out["DoorArch0"] = door_arch()
    out["DoorJamb0"] = door_jamb()
    for i in range(3):
        out[f"Win{i}"] = window(i)
    for i in range(2):
        out[f"Spout{i}"] = spout(i)
        out[f"Viga{i}"] = viga(i)
    out["MerlonCap0"] = merlon_cap()
    out["ParapetStep0"] = parapet_step()
    out["ParapetTooth0"] = parapet_tooth()
    out["CornerCap0"] = corner_cap()
    out["DomeRing0"] = dome_ring()
    out["DomeLantern0"] = dome_lantern()
    out["DomeFinial0"] = dome_finial()
    return out


def budget(name):
    for k, v in BUDGET.items():
        if name.startswith(k):
            return v
    return 1 << 30


def check(ms):
    over = []
    for name, m in ms.items():
        b = budget(name)
        print("ARCH", name, "verts", len(m.pos), "tris", m.tris(), "budget", b)
        if m.tris() > b:
            over.append(name)
    leaf = max(ms[f"DoorLeaf{i}"].tris() for i in range(3))
    flat = leaf + max(ms[f"DoorFrame{i}"].tris() for i in range(2))
    arched = leaf + ms["DoorArch0"].tris() + ms["DoorJamb0"].tris()
    print("ARCH door set: flat", flat, "arched", arched, "budget", DOOR_SET)
    if max(flat, arched) > DOOR_SET:
        over.append("door set")
    if over:
        raise SystemExit("over budget: " + ", ".join(over))


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
#
# The kit laid out on a plaster panel, and one facade put together the way build.ts does it: a
# wall with its openings cut (as wallFace / holeGeometry), the procedural spouts and beam ends, and
# the details stamped onto them. Colours follow the masonry shader's daylight palette roughly.

PLASTER_RGB = (0.84, 0.67, 0.47)


def rgb(mat, tint, hue, host=PLASTER_RGB):
    if mat == HOST or mat == PLASTER:
        k = 1.0 + tint * 1.6
        return tuple(c * k for c in host)
    if mat == ROOF:
        return tuple(min(1, c * 1.08) for c in host)
    if mat == STONE:
        k = 0.85 + 0.3 * tint
        return (0.74 * k, 0.66 * k, 0.55 * k)
    if mat == WOOD:
        if hue > 0.004:
            a, b = (0.5, 0.42, 0.36), (0.7, 0.42, 0.2)
            k = 0.7 + 0.6 * tint
            return tuple((a[i] + (b[i] - a[i]) * hue) * k * 0.85 for i in range(3))
        k = 0.85 + 0.3 * tint
        return (0.52 * k, 0.40 * k, 0.31 * k)
    if mat == OPENING:
        return (0.06, 0.045, 0.035)
    if mat == LANTERN:
        return (1.0, 0.74, 0.42)
    if mat == DOME:
        return (0.9, 0.86, 0.8)
    return (1, 0, 1)


class Scene:
    """Coloured triangles in the game frame, gathered into one Blender object per call to flush."""

    def __init__(self):
        self.m = Mesh()
        self.col = []

    def add(self, src, frame, host=PLASTER_RGB, host_mat=None):
        """src stamped with frame (origin, t, n, su, sy, sn): x along t, y up, z along n."""
        (ox, oy, oz), (tx, tz), (nx, nz), su, sy, sn = frame
        o = len(self.m.pos)
        for p, inf in zip(src.pos, src.info):
            x, y, z = p[0] * su, p[1] * sy, p[2] * sn
            self.m.pos.append((ox + tx * x + nx * z, oy + y, oz + tz * x + nz * z))
            mat, tint, hue = inf
            if mat == HOST and host_mat is not None:
                mat = host_mat
            self.col.append(rgb(mat, tint, hue, host))
            self.m.info.append(inf)
            self.m.uv.append((0, 0))
        # (t, up, n) may be a mirrored frame: keep the triangles facing out
        det = tx * nz - tz * nx
        for a, b, c in src.tri:
            self.m.tri.append((a + o, b + o, c + o) if det > 0 else (a + o, c + o, b + o))

    def quad(self, pts, rgbc, hint):
        tmp = Mesh()
        tmp.face(pts, 0, 0, hint)
        o = len(self.m.pos)
        self.m.pos += tmp.pos
        self.m.info += tmp.info
        self.m.uv += tmp.uv
        self.col += [rgbc] * len(tmp.pos)
        self.m.tri += [(a + o, b + o, c + o) for a, b, c in tmp.tri]

    def flush(self, name):
        ob = make_mesh(name, self.m)
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [c for t in self.col for c in (*t, 1.0)])
        return ob


IDENT = ((0, 0, 0), (1, 0), (0, 1), 1, 1, 1)


def at(x, y, z, su=1, sy=1, sn=1, t=(1, 0), n=(0, 1)):
    return ((x, y, z), t, n, su, sy, sn)


class Wall:
    """A flat wall facing +z (x along it, wall face at z = z0), with openings cut through it, as
    build.ts wallFace / holeGeometry / arch draw them."""

    def __init__(self, sc, x0, x1, y0, y1, z0, host=PLASTER_RGB):
        self.sc, self.x0, self.x1, self.y0, self.y1, self.z0, self.host = sc, x0, x1, y0, y1, z0, host
        self.holes = []

    def hole(self, u0, u1, y0, y1, d, back=OPENING, arch=0.0, point=0.3, k=3):
        self.holes.append(dict(u0=u0, u1=u1, y0=y0, y1=y1, d=d, back=back, arch=arch, point=point, k=k))

    def build(self):
        sc, z = self.sc, self.z0
        wall = self.host
        ys = sorted({self.y0, self.y1, *[h["y0"] for h in self.holes], *[h["y1"] for h in self.holes]})
        for ya, yb in zip(ys, ys[1:]):
            if ya < self.y0 or yb > self.y1:
                continue
            cur = self.x0
            for h in sorted(self.holes, key=lambda h: h["u0"]):
                if h["y0"] <= ya + 1e-6 and h["y1"] >= yb - 1e-6:
                    if h["u0"] > cur:
                        sc.quad([(cur, ya, z), (h["u0"], ya, z), (h["u0"], yb, z), (cur, yb, z)], wall, (0, 0, 1))
                    cur = max(cur, h["u1"])
            if cur < self.x1:
                sc.quad([(cur, ya, z), (self.x1, ya, z), (self.x1, yb, z), (cur, yb, z)], wall, (0, 0, 1))
        shade = tuple(c * 0.86 for c in wall)
        for h in self.holes:
            u0, u1, y0, y1, d = h["u0"], h["u1"], h["y0"], h["y1"], h["d"]
            sc.quad([(u0, y0, z - d), (u1, y0, z - d), (u1, y1, z - d), (u0, y1, z - d)], rgb(h["back"], 0.5, 0), (0, 0, 1))
            yspr = y1 - h["arch"] if h["arch"] > 0 else y1
            sc.quad([(u0, y0, z), (u0, y0, z - d), (u0, yspr, z - d), (u0, yspr, z)], shade, (1, 0, 0))
            sc.quad([(u1, y0, z), (u1, y0, z - d), (u1, yspr, z - d), (u1, yspr, z)], shade, (-1, 0, 0))
            sc.quad([(u0, y0, z), (u1, y0, z), (u1, y0, z - d), (u0, y0, z - d)], wall, (0, 1, 0))
            if h["arch"] <= 0:
                sc.quad([(u0, y1, z), (u1, y1, z), (u1, y1, z - d), (u0, y1, z - d)], shade, (0, -1, 0))
                continue
            cu, cy = arch_curve((u1 - u0) / 2, h["arch"], h["point"], h["k"])
            cu = [u0 + (u1 - u0) / 2 + c for c in cu]
            cy = [yspr + c for c in cy]
            K = h["k"]
            for i in range(2 * K):
                corner = u0 if i < K else u1
                tmp = [(corner, y1, z), (cu[i], cy[i], z), (cu[i + 1], cy[i + 1], z)]
                m = Mesh()
                m.face(tmp, 0, 0, (0, 0, 1))
                o = len(sc.m.pos)
                sc.m.pos += m.pos
                sc.m.info += m.info
                sc.m.uv += m.uv
                sc.col += [wall] * 3
                sc.m.tri += [(a + o, b + o, c + o) for a, b, c in m.tri]
                du, dy = cu[i + 1] - cu[i], cy[i + 1] - cy[i]
                sc.quad([(cu[i], cy[i], z), (cu[i + 1], cy[i + 1], z), (cu[i + 1], cy[i + 1], z - d), (cu[i], cy[i], z - d)], shade, (dy, -du, 0))


def box_into(sc, x0, y0, z0, x1, y1, z1, rgbc):
    m = Mesh()
    m.box(x0, y0, z0, x1, y1, z1, 0, 0, skip=())
    o = len(sc.m.pos)
    sc.m.pos += m.pos
    sc.m.info += m.info
    sc.m.uv += m.uv
    sc.col += [rgbc] * len(m.pos)
    sc.m.tri += [(a + o, b + o, c + o) for a, b, c in m.tri]


def setup_render(w=1600, h=1000):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.86, 0.74, 0.6, 1)
    bg.inputs[1].default_value = 0.55
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
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.8, 0.64, 0.45, 1)
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.active_object.data.materials.append(sand)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.2
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(52), 0, math.radians(-35))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam, mat


def finish(ob, mat):
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = False


def look_at(cam, eye, target, lens=50, ortho=None):
    import mathutils

    cam.location = eye
    d = mathutils.Vector(target) - mathutils.Vector(eye)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
        cam.data.lens = lens


def render(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def g2b(p):
    return to_blender(p)


def kit_scene(ms, out_dir):
    sc, cam, mat = setup_render(1800, 1000)
    S = Scene()
    # a plaster panel behind the wall-mounted pieces, with openings for the doors and windows
    W = Wall(S, -1.0, 15.0, 0.0, 4.2, 0.0)
    doors = [(0.6, "DoorFrame0", "DoorLeaf0", False), (3.4, "DoorFrame1", "DoorLeaf1", False), (6.3, None, "DoorLeaf2", True)]
    for x, frame, leaf, arched in doors:
        dw, dh = 1.1, 2.4
        W.hole(x - dw / 2, x + dw / 2, 0.0, dh, 0.42, WOOD, arch=dw / 2 if arched else 0.0)
        S.add(ms[leaf], at(x, 0, -0.42 + 0.004, dw / DOOR_W, dh / DOOR_H))
        if frame:
            S.add(ms[frame], at(x, 0, 0, dw / DOOR_W, dh / DOOR_H))
        else:
            S.add(ms["DoorArch0"], at(x, dh - dw / 2, 0, dw, dw, 1))
            S.add(ms["DoorJamb0"], at(x, 0, 0, dw / DOOR_W, dh - dw / 2))
    for k, x in enumerate((8.6, 10.2, 11.8)):
        ww, wh, sill = 0.7, 1.1, 1.2
        W.hole(x - ww / 2, x + ww / 2, sill, sill + wh, 0.32, OPENING, arch=ww / 2 if k == 0 else 0.0)
        S.add(ms[f"Win{k}"], at(x, sill, 0, ww / WIN_W, wh / WIN_H))
    W.build()
    # roof line: a coping, spouts and beam ends below it, a dome ring, lantern, finial
    box_into(S, -1.0, 4.2, -0.3, 15.0, 4.25, 0.0, rgb(HOST, 0.1, 0))
    for k, x in enumerate((0.5, 1.7)):
        box_into(S, x - 0.1, 3.86, 0.0, x + 0.1, 4.0, 0.75, rgb(WOOD, 0.5, 0))
        S.add(ms[f"Spout{k}"], at(x, 4.0, 0))
    for k, x in enumerate((3.0, 4.2, 5.4, 6.6)):
        box_into(S, x - 0.11, 3.5, 0.0, x + 0.11, 3.72, 0.55, rgb(WOOD, 0.4, 0))
        S.add(ms[f"Viga{k % 2}"], at(x, 3.5, 0, 1, 1, 0.59))
    for x in (8.0, 9.4, 10.8):
        S.add(ms["ParapetStep0"], at(x, 4.25, 0))
    S.add(ms["ParapetTooth0"], at(12.2, 4.25, 0))
    box_into(S, 13.1, 4.25, -0.3, 14.0, 4.75, 0.0, rgb(HOST, 0.05, 0))
    S.add(ms["MerlonCap0"], at(13.55, 4.75, 0))
    box_into(S, 14.2, 4.25, -0.65, 14.85, 4.75, 0.0, rgb(HOST, 0.05, 0))
    S.add(ms["CornerCap0"], at(14.525, 4.75, -0.325))
    ob = S.flush("kit")
    finish(ob, mat)
    # domes on the ground in front: a drum ring, a lantern and a finial
    D = Scene()
    for cx, piece in ((9.6, "DomeLantern0"), (12.8, "DomeFinial0")):
        r, y0, segs = 1.2, 0.0, 12
        cz = 3.0
        for k in range(segs):
            a0, a1 = k / segs * TAU, (k + 1) / segs * TAU
            p0 = (cx + math.cos(a0) * r, 0.9, cz + math.sin(a0) * r)
            p1 = (cx + math.cos(a1) * r, 0.9, cz + math.sin(a1) * r)
            D.quad([(p0[0], 0, p0[2]), (p1[0], 0, p1[2]), p1, p0], PLASTER_RGB, ((p0[0] + p1[0]) / 2 - cx, 0, (p0[2] + p1[2]) / 2 - cz))
            am = (a0 + a1) / 2
            chord = 2 * r * math.sin(math.pi / segs) + 0.03
            rr = r * math.cos(math.pi / segs)
            D.add(ms["DomeRing0"], at(cx + math.cos(am) * rr, 0.9, cz + math.sin(am) * rr, chord, 1, 1,
                                      t=(-math.sin(am), math.cos(am)), n=(math.cos(am), math.sin(am))))
        dm = Mesh()
        prof = [(r * 0.9 * math.cos(q * math.pi / 2), 0.9 + 1.0 * math.sin(q * math.pi / 2)) for q in [i / 6 for i in range(7)]]
        prof[-1] = (0.0, prof[-1][1])
        lathe(dm, prof, 16, PLASTER, 0.12)
        D.add(dm, at(cx, 0, cz))
        D.add(ms[piece], at(cx, 1.87, cz, 0.7, 0.7, 0.7))
    ob2 = D.flush("domes")
    finish(ob2, mat)
    look_at(cam, g2b((7.0, 3.2, 15.5)), g2b((7.0, 2.1, 0.0)), lens=34)
    render(sc, os.path.join(out_dir, "kit.png"))
    # close-ups
    look_at(cam, g2b((3.4, 1.7, 4.4)), g2b((3.4, 1.4, 0.0)), lens=40)
    render(sc, os.path.join(out_dir, "kit_doors.png"))
    look_at(cam, g2b((10.6, 2.2, 3.2)), g2b((10.2, 1.8, 0.0)), lens=40)
    render(sc, os.path.join(out_dir, "kit_windows.png"))
    look_at(cam, g2b((4.5, 2.6, 3.4)), g2b((4.5, 3.8, 0.0)), lens=40)
    render(sc, os.path.join(out_dir, "kit_roofline.png"))
    look_at(cam, g2b((11.2, 4.2, 9.5)), g2b((11.2, 1.5, 3.0)), lens=45)
    render(sc, os.path.join(out_dir, "kit_domes.png"))


def facade_scene(ms, out_dir):
    """One two-storey town house front as build.ts assembles it, with a domed hall behind."""
    sc, cam, mat = setup_render(1600, 1100)
    S = Scene()
    L, Hb, pb = 9.0, 6.5, 0.55
    top = Hb + pb
    W = Wall(S, 0.0, L, -0.5, top, 0.0)
    # side and back walls (plain) and the roof
    S.quad([(L, -0.5, 0), (L, -0.5, -7), (L, top, -7), (L, top, 0)], tuple(c * 0.97 for c in PLASTER_RGB), (1, 0, 0))
    S.quad([(0, Hb, 0), (L, Hb, 0), (L, Hb, -7), (0, Hb, -7)], rgb(ROOF, 0, 0), (0, 1, 0))
    # ground floor: a flat door, an arched door, small windows
    W.hole(1.6, 2.75, 0.0, 2.45, 0.45, WOOD)
    S.add(ms["DoorLeaf0"], at(2.175, 0, -0.45 + 0.004, 1.15, 2.45 / DOOR_H))
    S.add(ms["DoorFrame0"], at(2.175, 0, 0, 1.15, 2.45 / DOOR_H))
    W.hole(6.0, 7.1, 0.0, 2.4, 0.45, WOOD, arch=0.55)
    S.add(ms["DoorLeaf1"], at(6.55, 0, -0.45 + 0.004, 1.1, 2.4 / DOOR_H))
    S.add(ms["DoorArch0"], at(6.55, 2.4 - 0.55, 0, 1.1, 1.1, 1))
    S.add(ms["DoorJamb0"], at(6.55, 0, 0, 1.1, 2.4 - 0.55))
    for x, k in ((4.3, 1), (8.2, 2)):
        W.hole(x - 0.3, x + 0.3, 1.35, 2.0, 0.32)
        S.add(ms[f"Win{k}"], at(x, 1.35, 0, 0.6 / WIN_W, 0.65 / WIN_H))
    # upper storey
    for x, k in ((1.5, 0), (4.5, 1), (7.5, 0)):
        W.hole(x - 0.35, x + 0.35, 4.15, 5.3, 0.32, arch=0.0)
        S.add(ms[f"Win{k}"], at(x, 4.15, 0, 1, 1.15 / WIN_H))
    W.build()
    # coping and parapet on the front
    box_into(S, 0.0, Hb, -0.3, L, top, -0.3 + 0.0001, rgb(HOST, 0, 0))
    box_into(S, 0.0, top - 0.001, -0.3, L, top, 0.0, rgb(HOST, 0.08, 0))
    for k in range(6):
        x = 0.75 + k * 1.5
        S.add(ms["ParapetStep0"], at(x, top, 0))
    # beam ends in a row under the roof, spouts at the roof line
    yb = Hb - 0.5
    u = 0.7
    k = 0
    while u < L - 0.5:
        if not (3.9 < u < 5.1):
            ln = 0.45 + 0.15 * ((k * 37) % 10) / 10
            box_into(S, u - 0.11, yb, 0.0, u + 0.11, yb + 0.22, ln, rgb(WOOD, 0.4, 0))
            S.add(ms[f"Viga{k % 2}"], at(u, yb, 0, 1, 1, ln + 0.04))
        u += 1.35
        k += 1
    for k, x in enumerate((3.2, 5.8)):
        ys = Hb + 0.1
        box_into(S, x - 0.1, ys - 0.14, 0.0, x + 0.1, ys, 0.75, rgb(WOOD, 0.5, 0))
        S.add(ms[f"Spout{k}"], at(x, ys, 0))
    # a domed kiosk on the roof: drum, ring moulding, dome, lantern
    cx, cz, r, drum, hgt = 6.0, -3.6, 2.0, 0.9, 1.9
    segs = 16
    D = Scene()
    for k in range(segs):
        a0, a1 = k / segs * TAU, (k + 1) / segs * TAU
        p0 = (cx + math.cos(a0) * r, Hb + drum, cz + math.sin(a0) * r)
        p1 = (cx + math.cos(a1) * r, Hb + drum, cz + math.sin(a1) * r)
        D.quad([(p0[0], Hb, p0[2]), (p1[0], Hb, p1[2]), p1, p0], PLASTER_RGB, ((p0[0] + p1[0]) / 2 - cx, 0, (p0[2] + p1[2]) / 2 - cz))
        am = (a0 + a1) / 2
        chord = 2 * r * math.sin(math.pi / segs) + 0.03
        rr = r * math.cos(math.pi / segs)
        D.add(ms["DomeRing0"], at(cx + math.cos(am) * rr, Hb + drum, cz + math.sin(am) * rr, chord, 1, 1,
                                  t=(-math.sin(am), math.cos(am)), n=(math.cos(am), math.sin(am))))
    dm = Mesh()
    prof = [(r * 0.9 * math.cos(q * math.pi / 2), Hb + drum + hgt * math.sin(q * math.pi / 2)) for q in [i / 7 for i in range(8)]]
    prof[-1] = (0.0, prof[-1][1])
    lathe(dm, prof, segs, PLASTER, 0.15)
    D.add(dm, at(cx, 0, cz))
    s = max(0.45, min(1.3, r * 0.9 * 0.22))
    D.add(ms["DomeLantern0"], at(cx, Hb + drum + hgt - 0.04, cz, s, s, s))
    ob = S.flush("facade")
    finish(ob, mat)
    ob2 = D.flush("dome")
    finish(ob2, mat)
    look_at(cam, g2b((-1.5, 2.4, 13.0)), g2b((4.6, 3.6, 0.0)), lens=32)
    render(sc, os.path.join(out_dir, "facade.png"))
    look_at(cam, g2b((3.0, 1.6, 4.2)), g2b((4.2, 1.6, 0.0)), lens=30)
    render(sc, os.path.join(out_dir, "facade_ground.png"))
    look_at(cam, g2b((3.0, 3.6, 4.8)), g2b((4.5, 5.6, 0.0)), lens=32)
    render(sc, os.path.join(out_dir, "facade_upper.png"))


def preview(ms, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    kit_scene(ms, out_dir)
    facade_scene(ms, out_dir)

def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ms = models()
    check(ms)
    export(ms)
    print("ARCHITECTURE", OUT, os.path.getsize(OUT), "bytes")
    if "--preview" in argv:
        preview(ms, argv[argv.index("--preview") + 1])


main()
