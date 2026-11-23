"""Build public/art/equipment.glb: the modelled shapes of the wanderer's equipment (src/game/equipment.ts).

Everything is procedural. equipment.ts keeps its own geometry as the instant fallback and, once this
file has loaded, builds each piece from these shapes instead. The shapes carry no colour: every face
carries a part id, and equipment.ts colours the part from the design's spec, so the ten boards, ten
carpets and ten picks keep their own colours and patterns.

Coordinates are written in the game's space (three.js: +y up) and converted to Blender's on the way
in; the exporter converts back (+Y up). Each face has its own part, so a vertex is only shared by
faces of the same part (and cell).

Attributes, per point (they arrive in three.js lower-cased, as `_part` and `_cell`):
  _PART  float, the part of the piece the face belongs to (table per mesh below)
  _CELL  float2, on Board and Roll: the pattern cell (i, j) the face is coloured from

Meshes (the space each is written in):
  Board       a template, not a board: x = u (-1..1 across, times the design's half-width),
              y = height in metres (deck top at THICK, the underside thinning toward the tips),
              z = t (0 tail .. 1 nose; equipment.ts adds the rocker and the length).
              _PART 0 deck, 1 inlaid bevel along the rail, 2 rail and end grain, 3 underside.
              _CELL (i 0..3 across, j 0..17 along): the deck cell of the design's pattern.
  Roll        the rolled carpet, normalised: x -0.5..0.5 (times the roll's length), y and z in units
              of its radius. _PART 0 outer wrap (cell i along, k round from the free edge),
              1 end cloth, 2 end spiral, 3 strap, 4 the free edge, 5 buckle.
  Fringe      one tuft of fringe: x -0.5..0.5 (times its width), y in metres, z 0..1 (times its
              length) outward from the carpet's end. _PART 0 threads, 1 knot.
  Tassel      a corner tassel in metres, for the +x +z corner (mirrored for the others),
              hung from the corner at the origin. _PART 0 cord, 1 knot, 2 tuft.
  Pick0..9    the ten picks as in PICK_SPECS, grip at the origin, handle up y, head toward +z.
              _PART 0 handle, 1 wrap, 2 head, 3 head's tang and collar.
  Lamp        hung from its hook at the origin. _PART 0 iron, 1 glow inside, 2 dark iron.
  Spyglass    closed, along y, eyepiece at the origin. _PART 0 eye draw, 1 leather, 2 objective
              draw, 3 brass rings, 4 glass.
  Flute       along y, mouth at the top. _PART 0 cane, 1 binding, 2 holes.
  Bedroll     along x, centred. _PART 0 wool, 1 straps, 2 lining, 3 buckle.
  Rod         forked twig, tip toward +z, grips at x = +-0.095. _PART 0 wood, 1 cut ends, 2 knots.
  RopeCoil    lying flat on y = 0. _PART 0 rope, 1 rope's twist, 2 iron hook.
  Boot        stood on its sole at y = 0, toe toward +z. _PART 0 hide, 1 sole, 2 toe cap,
              3 cuff, 4 thong, 5 nails, 6 wrappings.
  Feather     stood on its quill at y = 0, flat to the front. _PART 0 vane, 1 bar, 2 tip, 3 shaft.

Run:  blender --background --python tools/blender/equipment.py
"""
import math
import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "art", "equipment.glb")

TAU = math.pi * 2

# --- keep in step with equipment.ts
BU, BT, THICK = 4, 18, 0.03
CX, CZ = 12, 20
HANDLE = 0.4


def board_thick(t):
    """How thick the board is along it, as a share of THICK (equipment.ts has the same)."""
    return 0.55 + 0.45 * math.sin(math.pi * min(1.0, max(0.0, t))) ** 0.35


def bl(p):
    """Game space (x, y up, z forward) to Blender space (x, y back, z up)."""
    return (p[0], -p[2], p[1])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def norm(a):
    l = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2) or 1.0
    return (a[0] / l, a[1] / l, a[2] / l)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def lerp(a, b, k):
    return tuple(a[i] + (b[i] - a[i]) * k for i in range(3))


class Mesh:
    """Faces with a part (and cell) each; a vertex is shared only within one part and cell."""

    def __init__(self, name, cells=False):
        self.name = name
        self.cells = cells
        self.verts = []
        self.vpart = []
        self.vcell = []
        self.key = {}
        self.faces = []
        self.part = 0
        self.cell = (0, 0)

    def v(self, p):
        k = (round(p[0], 6), round(p[1], 6), round(p[2], 6), self.part, self.cell)
        i = self.key.get(k)
        if i is None:
            i = len(self.verts)
            self.key[k] = i
            self.verts.append(tuple(p))
            self.vpart.append(self.part)
            self.vcell.append(self.cell)
        return i

    def face(self, *pts):
        idx = []
        for p in pts:
            i = self.v(p)
            if i not in idx:
                idx.append(i)
        if len(idx) >= 3:
            self.faces.append(idx)

    def quad(self, a, b, c, d):
        # as two triangles, so a bent quad stays as built
        self.face(a, b, c)
        self.face(a, c, d)

    def rings(self, pts, radii, sides, rot=0.0, flat=(1.0, 1.0), twist=0.0, up=None):
        """Rings across a line of points (the frame equipment.ts's tube uses)."""
        n = len(pts)
        out = []
        for i in range(n):
            a = pts[max(0, i - 1)]
            b = pts[min(n - 1, i + 1)]
            t = norm(sub(b, a))
            h = up or ((0, 0, 1) if abs(t[0]) > 0.9 else (1, 0, 0))
            v = norm(cross(t, h))
            u = cross(v, t)
            ring = []
            for j in range(sides):
                ang = rot + twist * i + j / sides * TAU
                cu = math.cos(ang) * radii[i] * flat[0]
                cv = math.sin(ang) * radii[i] * flat[1]
                p = pts[i]
                ring.append((p[0] + u[0] * cu + v[0] * cv, p[1] + u[1] * cu + v[1] * cv, p[2] + u[2] * cu + v[2] * cv))
            out.append(ring)
        return out

    def tube(self, pts, radii, sides, rot=0.0, flat=(1.0, 1.0), caps=(True, True), twist=0.0, parts=None, cap_part=None, up=None):
        """A tube along points; `parts` gives a part per segment, `cap_part` one for the end caps."""
        rs = self.rings(pts, radii, sides, rot, flat, twist, up)
        base = self.part
        for i in range(len(rs) - 1):
            if parts is not None:
                self.part = parts[i]
            for j in range(sides):
                k = (j + 1) % sides
                self.quad(rs[i][j], rs[i][k], rs[i + 1][k], rs[i + 1][j])
        self.part = base
        for end, on in ((0, caps[0]), (len(rs) - 1, caps[1])):
            if not on:
                continue
            if cap_part is not None:
                self.part = cap_part
            elif parts is not None:
                self.part = parts[0 if end == 0 else -1]
            r = rs[end]
            self.face(*(r if end else list(reversed(r))))
            self.part = base
        return rs

    def lathe(self, prof, sides, axis="y", rot=0.0, flat=(1.0, 1.0), caps=(True, True)):
        """A turned shape round an axis: prof is (along, radius, part of the segment that follows)."""
        def at(s, r, j):
            a = rot + j / sides * TAU
            c, d = math.cos(a) * r * flat[0], math.sin(a) * r * flat[1]
            return (c, s, d) if axis == "y" else (s, c, d)
        for n in range(len(prof) - 1):
            s0, r0, part = prof[n]
            s1, r1, _ = prof[n + 1]
            self.part = part
            for j in range(sides):
                self.quad(at(s0, r0, j), at(s0, r0, j + 1), at(s1, r1, j + 1), at(s1, r1, j))
        for end, on in ((0, caps[0]), (-1, caps[1])):
            if on and prof[end][1] > 1e-5:
                s, r, part = prof[end]
                self.part = prof[0][2] if end == 0 else prof[-2][2]
                ring = [at(s, r, j) for j in range(sides)]
                self.face(*(ring if end else list(reversed(ring))))

    def box(self, c, s):
        x0, x1 = c[0] - s[0] / 2, c[0] + s[0] / 2
        y0, y1 = c[1] - s[1] / 2, c[1] + s[1] / 2
        z0, z1 = c[2] - s[2] / 2, c[2] + s[2] / 2
        P = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)):
            self.quad(*(P[i] for i in f))

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)

    def object(self):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata([bl(v) for v in self.verts], [], self.faces)
        me.validate()
        me.update()
        for poly in me.polygons:
            poly.use_smooth = False
        at = me.attributes.new("_PART", "FLOAT", "POINT")
        for i, p in enumerate(self.vpart):
            at.data[i].value = float(p)
        if self.cells:
            ac = me.attributes.new("_CELL", "FLOAT2", "POINT")
            for i, c in enumerate(self.vcell):
                ac.data[i].vector = (float(c[0]), float(c[1]))
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


# ------------------------------------------------------------------ board


def build_board():
    """The template every board is shaped from: rails, a bevelled inlay, a thinning underside."""
    m = Mesh("Board", cells=True)
    ts = [0.0, 0.5 / BT] + [j / BT for j in range(1, BT)] + [(BT - 0.5) / BT, 1.0]
    ud = [-0.84, -0.5, 0.0, 0.5, 0.84]   # deck cells across (inner bounds as the old flat board)
    uu = [-0.9, -0.5, 0.0, 0.5, 0.9]     # underside cells
    bottom = lambda t: THICK * (1 - board_thick(t))
    bevel = lambda t: THICK - 0.012 * board_thick(t)
    for r in range(len(ts) - 1):
        t0, t1 = ts[r], ts[r + 1]
        j = min(BT - 1, int((t0 + t1) / 2 * BT))
        for i in range(BU):
            m.cell = (i, j)
            m.part = 0
            m.quad((ud[i], THICK, t0), (ud[i], THICK, t1), (ud[i + 1], THICK, t1), (ud[i + 1], THICK, t0))
            m.part = 3
            m.quad((uu[i], bottom(t0), t0), (uu[i + 1], bottom(t0), t0), (uu[i + 1], bottom(t1), t1), (uu[i], bottom(t1), t1))
        for sx, i in ((-1, 0), (1, BU - 1)):
            m.cell = (i, j)
            e0, e1 = (sx * 0.84, THICK, t0), (sx * 0.84, THICK, t1)
            b0, b1 = (sx * 0.985, bevel(t0), t0), (sx * 0.985, bevel(t1), t1)
            u0, u1 = (sx * 0.9, bottom(t0), t0), (sx * 0.9, bottom(t1), t1)
            m.part = 1
            m.quad(e0, b0, b1, e1) if sx > 0 else m.quad(e0, e1, b1, b0)
            m.part = 2
            m.quad(b0, u0, u1, b1) if sx > 0 else m.quad(b0, b1, u1, u0)
    # the end grain at tail and nose, for the outlines that end blunt or square
    m.part = 2
    for t, j in ((0.0, 0), (1.0, BT - 1)):
        for i in range(BU):
            m.cell = (i, j)
            m.quad((ud[i], THICK, t), (ud[i + 1], THICK, t), (uu[i + 1], bottom(t), t), (uu[i], bottom(t), t))
        for sx, i in ((-1, 0), (1, BU - 1)):
            m.cell = (i, j)
            m.face((sx * 0.84, THICK, t), (sx * 0.985, bevel(t), t), (sx * 0.9, bottom(t), t))
    return m


# ------------------------------------------------------------------ carpet: roll, fringe, tassel

ROLL_FLAP = -math.pi / 4   # where the free edge lies round the roll: up and toward the back
ROLL_SIDES = 8
ROLL_STEP = 0.08           # the outermost layer's thickness, in radii


def build_roll():
    m = Mesh("Roll", cells=True)
    xs = [i / CX - 0.5 for i in range(CX + 1)]

    def outer(x, k, lift=0.0):
        a = ROLL_FLAP + k / ROLL_SIDES * TAU
        r = 1 - ROLL_STEP * (k / ROLL_SIDES) + lift
        return (x, math.cos(a) * r, math.sin(a) * r)

    # the outer wrap, its weave showing the end rows of the carpet from the free edge in
    for i in range(CX):
        for k in range(ROLL_SIDES):
            m.cell = (i, k)
            m.part = 0
            m.quad(outer(xs[i], k), outer(xs[i + 1], k), outer(xs[i + 1], k + 1), outer(xs[i], k + 1))
        # the free edge, a step down onto the turn beneath
        m.cell = (i, 0)
        m.part = 4
        m.quad(outer(xs[i], 0), outer(xs[i], ROLL_SIDES), outer(xs[i + 1], ROLL_SIDES), outer(xs[i + 1], 0))
    m.cell = (0, 0)

    # the ends: the cloth seen edge on, the layers drawn as a spiral, the middle pushed out a little
    turns, segs = 3.0, ROLL_SIDES
    for sx in (-1, 1):
        def end_pt(a, r, out=0.0):
            x = sx * (0.5 + 0.035 * (1 - r) + out)
            return (x, math.cos(a) * r, math.sin(a) * r)
        m.part = 1
        centre = end_pt(0, 0.0)
        for k in range(ROLL_SIDES):
            q0 = end_pt(ROLL_FLAP + k / ROLL_SIDES * TAU, 1 - ROLL_STEP * k / ROLL_SIDES)
            q1 = end_pt(ROLL_FLAP + (k + 1) / ROLL_SIDES * TAU, 1 - ROLL_STEP * (k + 1) / ROLL_SIDES)
            m.face(centre, q1, q0) if sx > 0 else m.face(centre, q0, q1)
        m.part = 2
        n = int(turns * segs)
        for s in range(n):
            a0 = ROLL_FLAP + s / segs * TAU
            a1 = ROLL_FLAP + (s + 1) / segs * TAU
            r0 = 1 - ROLL_STEP - s / n * 0.78
            r1 = 1 - ROLL_STEP - (s + 1) / n * 0.78
            w = 0.045
            pts = (end_pt(a0, r0, 0.004), end_pt(a1, r1, 0.004), end_pt(a1, r1 - w, 0.004), end_pt(a0, r0 - w, 0.004))
            m.quad(*pts) if sx > 0 else m.quad(*reversed(pts))

    # two straps, following the wrap a little proud of it, each with a buckle on top
    for xc in (-0.28, 0.28):
        m.part = 3
        hw = 0.032
        for k in range(ROLL_SIDES):
            m.quad(outer(xc - hw, k, 0.035), outer(xc + hw, k, 0.035), outer(xc + hw, k + 1, 0.035), outer(xc - hw, k + 1, 0.035))
        # the strap's turned end across the step
        m.quad(outer(xc - hw, 0, 0.035), outer(xc - hw, ROLL_SIDES, 0.035), outer(xc + hw, ROLL_SIDES, 0.035), outer(xc + hw, 0, 0.035))
        m.part = 5
        # on the middle of the first facet past the free edge, lying flat on the strap
        p0, p1 = outer(xc, 0, 0.035), outer(xc, 1, 0.035)
        tang = norm(sub(p1, p0))
        nrm = (0, -tang[2], tang[1]) if (p0[1] + p1[1]) * -tang[2] + (p0[2] + p1[2]) * tang[1] > 0 else (0, tang[2], -tang[1])
        mid = lerp(p0, p1, 0.5)
        c = (xc, mid[1] + nrm[1] * 0.03, mid[2] + nrm[2] * 0.03)
        bw, bh, bd = 0.05, 0.17, 0.03
        def bp(dx, dt, dn):
            return (c[0] + dx, c[1] + tang[1] * dt + nrm[1] * dn, c[2] + tang[2] * dt + nrm[2] * dn)
        top = [bp(-bw, -bh, bd), bp(bw, -bh, bd), bp(bw, bh, bd), bp(-bw, bh, bd)]
        bot = [bp(-bw, -bh, -bd), bp(bw, -bh, -bd), bp(bw, bh, -bd), bp(-bw, bh, -bd)]
        m.quad(*top)
        for q in range(4):
            q1 = (q + 1) % 4
            m.quad(bot[q], bot[q1], top[q1], top[q])
    return m


def build_fringe():
    """One tuft: a knot at the carpet's edge and three threads splaying out, a touch above the cloth."""
    m = Mesh("Fringe")
    m.part = 1
    m.quad((-0.32, 0.002, 0.0), (0.32, 0.002, 0.0), (0.22, 0.005, 0.16), (-0.22, 0.005, 0.16))
    m.quad((-0.22, 0.005, 0.16), (0.22, 0.005, 0.16), (0.1, 0.003, 0.26), (-0.1, 0.003, 0.26))
    m.part = 0
    for x0, x1, w in ((-0.08, -0.34, 0.12), (0.0, 0.04, 0.13), (0.08, 0.36, 0.12)):
        a, b = (x0 - w, 0.003, 0.22), (x0 + w, 0.003, 0.22)
        mid_l, mid_r = (x0 + (x1 - x0) * 0.6 - w * 0.6, 0.002, 0.66), (x0 + (x1 - x0) * 0.6 + w * 0.6, 0.002, 0.66)
        tip = (x1, 0.001, 1.0)
        m.quad(a, b, mid_r, mid_l)
        m.face(mid_l, mid_r, tip)
    return m


def build_tassel():
    """A corner tassel: a short cord, a bound knot, a tuft fanning out flat behind it."""
    m = Mesh("Tassel")
    d = norm((1, 0, 1))
    side = (-d[2], 0, d[0])
    P = lambda s, w=0.0, y=0.0: (d[0] * s + side[0] * w, y, d[2] * s + side[2] * w)
    m.part = 0
    m.tube([P(0.0, y=0.004), P(0.08, y=0.006), P(0.12, y=0.008)], [0.007, 0.006, 0.006], 4, rot=math.pi / 4, caps=(False, False))
    m.part = 1
    m.tube([P(0.115, y=0.01), P(0.135, y=0.012), P(0.16, y=0.012), P(0.175, y=0.01)], [0.009, 0.019, 0.02, 0.012], 5)
    m.part = 2
    for k in range(5):
        w = (k - 2) * 0.008
        spread = (k - 2) * 0.014
        a, b = P(0.17, w - 0.007, 0.01), P(0.17, w + 0.007, 0.01)
        c = P(0.3, spread + 0.006, 0.003)
        e = P(0.3, spread - 0.006, 0.003)
        m.quad(a, b, c, e)
        m.face(e, c, P(0.33, spread * 1.15, 0.001))
    return m


# ------------------------------------------------------------------ picks


def handle(m, length=HANDLE, r=0.016, part=0):
    """A wooden haft, six-sided, swelling to a knob at the butt."""
    m.part = part
    m.tube([(0, -0.014, 0), (0, 0.0, 0), (0, 0.025, 0), (0, length * 0.55, 0), (0, length, 0)],
           [r * 0.75, r * 1.28, r * 1.08, r * 0.96, r * 1.06], 6, rot=0.3)


def wrap(m, y0, y1, r=0.022, turns=None, part=1):
    """A binding round the haft, ridged where each turn lies over the last."""
    m.part = part
    n = turns or max(2, int(round((y1 - y0) / 0.03)))
    pts, rad = [], []
    for k in range(n * 2 + 1):
        pts.append((0, y0 + (y1 - y0) * k / (n * 2), 0))
        rad.append(r if k % 2 else r * 0.88)
    m.tube(pts, rad, 6, rot=0.3, twist=0.35)


def collar(m, y0, y1, r=0.024):
    """The eye of the head round the haft, with the tang running down it."""
    m.part = 3
    m.tube([(0, y0, 0), (0, (y0 + y1) / 2, 0), (0, y1, 0)], [r * 0.92, r, r * 0.9], 6, rot=0.3)


def pick0(m):  # Spike
    handle(m)
    wrap(m, 0.03, 0.12, 0.019)
    collar(m, HANDLE - 0.045, HANDLE + 0.02)
    m.part = 2
    m.tube([(0, HANDLE - 0.012, -0.045), (0, HANDLE + 0.008, 0.0), (0, HANDLE + 0.016, 0.07), (0, HANDLE - 0.012, 0.15), (0, HANDLE - 0.06, 0.21), (0, HANDLE - 0.1, 0.235)],
           [0.016, 0.024, 0.02, 0.014, 0.007, 0.001], 4, rot=math.pi / 4, flat=(0.8, 1.0))


def pick1(m):  # Pick
    handle(m)
    wrap(m, 0.02, 0.1, 0.019)
    collar(m, HANDLE - 0.04, HANDLE + 0.025)
    m.part = 2
    m.tube([(0, HANDLE - 0.07, -0.19), (0, HANDLE - 0.03, -0.13), (0, HANDLE - 0.003, -0.06), (0, HANDLE + 0.01, 0.0),
            (0, HANDLE - 0.003, 0.06), (0, HANDLE - 0.03, 0.13), (0, HANDLE - 0.07, 0.19)],
           [0.001, 0.01, 0.017, 0.024, 0.017, 0.01, 0.001], 4, rot=math.pi / 4, flat=(0.75, 1.0))


def pick2(m):  # Adze
    handle(m)
    wrap(m, HANDLE - 0.06, HANDLE + 0.005, 0.024, turns=3)
    collar(m, HANDLE - 0.012, HANDLE + 0.022, 0.026)
    m.part = 2
    # the blade: thick at the eye, thinning and widening to a curved edge
    m.tube([(0, HANDLE + 0.01, -0.012), (0, HANDLE + 0.006, 0.04), (0, HANDLE - 0.012, 0.095), (0, HANDLE - 0.05, 0.14), (0, HANDLE - 0.095, 0.158)],
           [0.022, 0.026, 0.034, 0.043, 0.047], 4, rot=math.pi / 4, flat=(1.45, 0.24))
    m.part = 3
    m.tube([(0, HANDLE - 0.096, 0.159), (0, HANDLE - 0.104, 0.162)], [0.047, 0.044], 4, rot=math.pi / 4, flat=(1.45, 0.08))


def pick3(m):  # Claw
    handle(m)
    wrap(m, 0.02, 0.14, 0.021)
    collar(m, HANDLE - 0.035, HANDLE + 0.015)
    m.part = 2
    for sx in (-1, 1):
        m.tube([(0, HANDLE - 0.005, 0), (sx * 0.028, HANDLE + 0.03, 0.06), (sx * 0.04, HANDLE + 0.012, 0.125), (sx * 0.04, HANDLE - 0.04, 0.165), (sx * 0.034, HANDLE - 0.1, 0.172)],
               [0.016, 0.014, 0.011, 0.007, 0.001], 4, rot=math.pi / 4)


def pick4(m):  # Trowel
    handle(m, 0.26)
    wrap(m, 0.2, 0.28, 0.021)
    m.part = 3
    m.tube([(0, 0.255, 0), (0, 0.31, 0.004)], [0.011, 0.007], 4, rot=math.pi / 4)  # the tang
    m.part = 2
    m.tube([(0, 0.275, 0.004), (0, 0.3, 0.008), (0, 0.345, 0.013), (0, 0.4, 0.016), (0, 0.46, 0.012), (0, 0.51, 0.004)],
           [0.012, 0.038, 0.046, 0.042, 0.026, 0.002], 4, rot=math.pi / 4, flat=(1.0, 0.16))


def pick5(m):  # Fork
    handle(m, 0.3)
    wrap(m, 0.03, 0.11, 0.019)
    collar(m, 0.27, 0.31, 0.02)
    m.part = 2
    m.tube([(-0.062, 0.305, 0), (-0.03, 0.312, 0), (0.03, 0.312, 0), (0.062, 0.305, 0)], [0.011, 0.014, 0.014, 0.011], 4, rot=math.pi / 4)
    for sx in (-1, 0, 1):
        m.tube([(sx * 0.048, 0.31, 0), (sx * 0.05, 0.37, 0.012), (sx * 0.05, 0.43, 0.018), (sx * 0.048, 0.49, 0.006)], [0.009, 0.008, 0.006, 0.001], 4, rot=math.pi / 4)


def pick6(m):  # Bone pick
    m.part = 0
    m.tube([(0, -0.01, 0), (0, 0.012, 0), (0, 0.04, 0), (0, HANDLE * 0.5, 0), (0, HANDLE - 0.035, 0), (0, HANDLE + 0.005, 0), (0, HANDLE + 0.025, 0)],
           [0.016, 0.028, 0.018, 0.014, 0.017, 0.026, 0.018], 6, rot=0.2)
    m.part = 2
    m.tube([(0, HANDLE - 0.022, -0.06), (0, HANDLE - 0.012, 0.0), (0, HANDLE - 0.025, 0.07), (0, HANDLE - 0.05, 0.13), (0, HANDLE - 0.075, 0.18)],
           [0.012, 0.028, 0.024, 0.013, 0.002], 5, rot=0.3, flat=(0.72, 1.0))
    wrap(m, HANDLE - 0.06, HANDLE - 0.015, 0.031, turns=3)


def pick7(m):  # Hammer
    handle(m)
    wrap(m, 0.02, 0.16, 0.021)
    collar(m, HANDLE - 0.04, HANDLE + 0.012)
    m.part = 2
    # the square face behind, a spike ahead
    m.tube([(0, HANDLE, 0.0), (0, HANDLE, -0.05), (0, HANDLE, -0.075), (0, HANDLE, -0.085)], [0.024, 0.033, 0.036, 0.032], 4, rot=math.pi / 4)
    m.tube([(0, HANDLE, 0.0), (0, HANDLE + 0.002, 0.06), (0, HANDLE - 0.015, 0.12), (0, HANDLE - 0.045, 0.175)], [0.024, 0.018, 0.01, 0.001], 4, rot=math.pi / 4)


def pick8(m):  # Sickle
    handle(m, 0.3)
    wrap(m, 0.03, 0.12, 0.019)
    collar(m, 0.27, 0.315, 0.02)
    m.part = 3
    m.tube([(0, 0.3, 0.0), (0, 0.33, 0.012), (0, 0.352, 0.036)], [0.013, 0.012, 0.01], 4, rot=math.pi / 4)  # the tang
    m.part = 2
    pts, rad = [], []
    n = 8
    for k in range(n + 1):
        a = -0.5 + k / n * 3.0
        pts.append((0, 0.39 + math.sin(a) * 0.1, 0.02 + (1 - math.cos(a)) * 0.1))
        rad.append(0.004 + 0.026 * math.sin(k / n * math.pi) ** 0.8)
    m.tube(pts, rad, 4, rot=math.pi / 4, flat=(0.2, 1.0))


def pick9(m):  # Wedge
    handle(m, HANDLE, 0.018)
    m.part = 2
    m.tube([(0, HANDLE - 0.075, -0.05), (0, HANDLE - 0.02, -0.028), (0, HANDLE + 0.022, 0.03), (0, HANDLE + 0.01, 0.1), (0, HANDLE - 0.035, 0.15)],
           [0.026, 0.05, 0.048, 0.03, 0.004], 5, rot=0.3, flat=(0.75, 1.0))
    wrap(m, HANDLE - 0.095, HANDLE - 0.055, 0.028, turns=2)
    wrap(m, HANDLE - 0.035, HANDLE - 0.005, 0.03, turns=2)


PICKS = [pick0, pick1, pick2, pick3, pick4, pick5, pick6, pick7, pick8, pick9]


def build_picks():
    out = []
    for i, f in enumerate(PICKS):
        m = Mesh(f"Pick{i}")
        f(m)
        out.append(m)
    return out


# ------------------------------------------------------------------ small things


def build_lamp():
    """A six-sided lantern of pierced iron with a glow inside, hung from a hook over its bail."""
    m = Mesh("Lamp")
    S = 6
    R = 0.04
    # the hook it hangs from (its top at the origin's height plus a little) and the bail
    m.part = 2
    m.tube([(0.0, 0.008, 0), (0.0, 0.03, 0), (0.008, 0.044, 0), (0.02, 0.038, 0), (0.022, 0.026, 0)], [0.004, 0.004, 0.004, 0.004, 0.003], 4, rot=math.pi / 4)
    m.part = 0
    arc = [(math.cos(a) * 0.03, -0.016 + math.sin(a) * 0.026, 0) for a in [math.pi * k / 6 for k in range(7)]]
    m.tube(arc, [0.0045] * 7, 4, rot=math.pi / 4, caps=(False, False))
    # roof and finial
    m.lathe([(0.012, 0.0, 2), (0.006, 0.008, 2), (-0.012, 0.012, 0), (-0.042, 0.05, 0), (-0.05, 0.054, 0), (-0.052, 0.042, 0)], S, rot=math.pi / 6, caps=(False, True))
    # the glow inside
    m.part = 1
    m.lathe([(-0.052, 0.034, 1), (-0.158, 0.034, 1)], S, rot=math.pi / 6, caps=(False, False))
    # pierced panels: a 3 x 4 grid on each face, every other cell cut away
    corners = [(math.cos(math.pi / 6 + k / S * TAU) * R, math.sin(math.pi / 6 + k / S * TAU) * R) for k in range(S)]
    y0, y1 = -0.052, -0.158
    for k in range(S):
        a, b = corners[k], corners[(k + 1) % S]
        for row in range(4):
            for col in range(3):
                cut = (row in (1, 2)) and ((row + col + k) % 2 == 0)
                if cut:
                    continue
                m.part = 2 if row in (0, 3) else 0
                ua, ub = col / 3, (col + 1) / 3
                ya, yb = y0 + (y1 - y0) * row / 4, y0 + (y1 - y0) * (row + 1) / 4
                pa = (a[0] + (b[0] - a[0]) * ua, a[1] + (b[1] - a[1]) * ua)
                pb = (a[0] + (b[0] - a[0]) * ub, a[1] + (b[1] - a[1]) * ub)
                m.quad((pa[0], ya, pa[1]), (pb[0], ya, pb[1]), (pb[0], yb, pb[1]), (pa[0], yb, pa[1]))
    # the base it stands on
    m.lathe([(-0.158, 0.046, 2), (-0.166, 0.05, 2), (-0.178, 0.044, 2)], S, rot=math.pi / 6, caps=(True, True))
    return m


def build_spyglass():
    m = Mesh("Spyglass")
    m.lathe([
        (-0.002, 0.012, 3), (-0.006, 0.021, 3), (0.008, 0.022, 3), (0.012, 0.0165, 0),
        (0.08, 0.0185, 3), (0.086, 0.023, 3), (0.096, 0.023, 1), (0.096, 0.025, 1),
        (0.19, 0.0275, 3), (0.2, 0.03, 3), (0.21, 0.031, 2),
        (0.258, 0.0335, 3), (0.26, 0.037, 3), (0.278, 0.037, 4), (0.278, 0.0, 4),
    ], 7, rot=math.pi / 7, caps=(True, False))
    return m


def build_flute():
    m = Mesh("Flute")
    prof = [(0.0, 0.0, 2), (0.0, 0.0125, 1), (0.03, 0.0148, 1), (0.034, 0.0127, 0),
            (0.05, 0.0124, 1), (0.053, 0.0152, 1), (0.068, 0.0152, 0), (0.071, 0.0122, 0),
            (0.188, 0.0117, 1), (0.191, 0.0146, 1), (0.21, 0.0146, 0), (0.213, 0.0115, 0),
            (0.33, 0.011, 1), (0.333, 0.014, 1), (0.352, 0.014, 0), (0.355, 0.0108, 0),
            (0.4, 0.0105, 2), (0.4, 0.006, 2), (0.385, 0.0, 2)]
    m.lathe(prof, 5, rot=math.pi / 2, caps=(False, False))
    # finger holes down the front, and the mouth hole near the top
    m.part = 2
    for y, s in [(0.09, 0.0045), (0.118, 0.0045), (0.146, 0.0045), (0.174, 0.0045), (0.245, 0.004), (0.375, 0.005)]:
        z = 0.0119 - (y / 0.4) * 0.0018
        m.quad((-s, y - s, z), (s, y - s, z), (s, y + s, z), (-s, y + s, z))
    return m


def build_bedroll():
    m = Mesh("Bedroll")
    L, S = 0.25, 8
    flat = (1.0, 0.9)
    m.lathe([(-L, 0.06, 0), (-L + 0.03, 0.074, 0), (L - 0.03, 0.074, 0), (L, 0.06, 0)], S, axis="x", rot=math.pi / 8, flat=flat, caps=(False, False))
    for sx in (-1, 1):
        # the end: wool with the lining showing as a spiral
        def ep(a, r, out=0.0):
            return (sx * (L + out + 0.012 * (1 - r / 0.06)), math.cos(a) * r * flat[0], math.sin(a) * r * flat[1])
        m.part = 0
        c = ep(0, 0.0)
        for k in range(S):
            a0, a1 = math.pi / 8 + k / S * TAU, math.pi / 8 + (k + 1) / S * TAU
            m.face(c, ep(a0, 0.06), ep(a1, 0.06)) if sx < 0 else m.face(c, ep(a1, 0.06), ep(a0, 0.06))
        m.part = 2
        n = int(2.25 * S)
        for s in range(n):
            a0, a1 = s / S * TAU, (s + 1) / S * TAU
            r0, r1 = 0.056 - s / n * 0.048, 0.056 - (s + 1) / n * 0.048
            q = (ep(a0, r0, 0.002), ep(a1, r1, 0.002), ep(a1, r1 - 0.007, 0.002), ep(a0, r0 - 0.007, 0.002))
            m.quad(*q) if sx > 0 else m.quad(*reversed(q))
    for x in (-0.13, 0.13):
        m.lathe([(x - 0.014, 0.0795, 1), (x + 0.014, 0.0795, 1)], S, axis="x", rot=math.pi / 8, flat=flat, caps=(False, False))
        m.part = 3
        m.box((x, 0.072, 0.0), (0.03, 0.02, 0.012))
    return m


def build_rod():
    m = Mesh("Rod")
    fork = (0, 0, 0.17)
    m.part = 0
    m.tube([fork, (0, 0.002, 0.215), (0, 0.005, 0.24), (0, 0.004, 0.3), (0, 0.0, 0.36)],
           [0.012, 0.0108, 0.0118, 0.0085, 0.004], 5, rot=0.4, parts=[0, 2, 0, 0], caps=(False, True))
    for sx in (-1, 1):
        m.tube([(sx * 0.004, 0, 0.175), (sx * 0.03, 0.001, 0.125), (sx * 0.055, 0.002, 0.088), (sx * 0.072, 0.001, 0.06), (sx * 0.095, 0, 0.0), (sx * 0.1, 0, -0.012)],
               [0.0115, 0.0105, 0.0118, 0.0102, 0.0098, 0.0098], 5, rot=0.4, parts=[0, 0, 2, 0, 1], cap_part=1)
    # the knob where the fork meets, and a cut side shoot
    m.part = 2
    m.tube([(0, -0.004, 0.16), (0, -0.002, 0.172), (0, 0.003, 0.182)], [0.01, 0.0145, 0.01], 5, rot=0.4)
    m.tube([(0.002, 0.004, 0.27), (0.016, 0.012, 0.292)], [0.005, 0.0035], 4, rot=0.2, cap_part=1)
    return m


def build_rope():
    m = Mesh("RopeCoil")
    # a coil of two and a half turns rising a little, the strands twisting round it
    pts, n = [], 13
    for i in range(n + 1):
        s = i / n
        a = s * 2.0 * TAU
        r = 0.17 - 0.012 * s + 0.006 * math.sin(a * 1.5)
        pts.append((math.cos(a) * r, 0.022 + 0.06 * s, math.sin(a) * r))
    # run out over the side to the hook
    last = pts[-1]
    pts += [(last[0] + 0.03, 0.08, last[2] + 0.06), (0.24, 0.03, 0.12)]
    rs = m.rings(pts, [0.021] * len(pts), 5, twist=TAU / 12, up=(0, 1, 0))
    for i in range(len(rs) - 1):
        for j in range(5):
            m.part = j % 2
            k = (j + 1) % 5
            m.quad(rs[i][j], rs[i][k], rs[i + 1][k], rs[i + 1][j])
    m.part = 1
    m.face(*reversed(rs[0]))
    m.face(*rs[-1])
    # the hook: a shank and three prongs curling back
    m.part = 2
    hx, hz = 0.25, 0.12
    m.tube([(hx - 0.01, 0.03, hz), (hx + 0.13, 0.03, hz + 0.03)], [0.012, 0.011], 3, caps=(False, True))
    for i in range(3):
        a = i / 3 * TAU + 0.5
        oy, oz = math.cos(a) * 0.055, math.sin(a) * 0.055
        m.tube([(hx + 0.13, 0.03, hz + 0.03), (hx + 0.165, 0.03 + oy * 0.7, hz + 0.038 + oz * 0.7), (hx + 0.13, 0.03 + oy, hz + 0.03 + oz)],
               [0.01, 0.008, 0.002], 3, caps=(False, False))
    return m


def build_boot():
    m = Mesh("Boot")
    # the sole, and the nails along its edge
    m.part = 1
    m.box((0, 0.009, 0.035), (0.07, 0.018, 0.168))
    m.part = 5
    for z in (-0.03, 0.035, 0.095):
        for x in (-0.0352, 0.0352):
            m.quad((x, 0.003, z - 0.006), (x, 0.003, z + 0.006), (x, 0.012, z + 0.006), (x, 0.012, z - 0.006))
    # the foot: hide wrapped over the last, rounded at the toe
    m.part = 0
    m.tube([(0, 0.04, -0.045), (0, 0.042, 0.02), (0, 0.038, 0.08), (0, 0.032, 0.112), (0, 0.028, 0.122)],
           [0.024, 0.026, 0.025, 0.019, 0.008], 6, flat=(1.25, 0.95), parts=[0, 0, 2, 2], caps=(False, True))
    # the shaft, wound with strips of hide from the ankle up
    m.tube([(0, 0.022, -0.028), (0, 0.09, -0.03), (0, 0.155, -0.032)], [0.034, 0.035, 0.039], 6, rot=0.2, caps=(False, False))
    m.part = 6
    for k in range(3):
        # a strip wound slantwise, a little proud of the shaft
        yc = 0.07 + k * 0.03
        r = 0.035 + (yc - 0.022) / 0.133 * 0.004 + 0.0025
        lo, hi = [], []
        for j in range(6):
            a = 0.2 + j / 6 * TAU
            y = yc + 0.009 * math.sin(a)
            p = (math.cos(a) * r, y, -0.03 + math.sin(a) * r)
            lo.append((p[0], y - 0.006, p[2]))
            hi.append((p[0], y + 0.006, p[2]))
        for j in range(6):
            q = (j + 1) % 6
            m.quad(lo[j], lo[q], hi[q], hi[j])
    m.part = 4
    m.tube([(0, 0.044, -0.03), (0, 0.054, -0.03)], [0.037, 0.037], 6, rot=0.2, caps=(False, False))
    m.part = 3
    m.lathe([(0.146, 0.04, 3), (0.15, 0.047, 3), (0.178, 0.048, 3), (0.178, 0.036, 3)], 6, rot=0.2, caps=(False, False))
    return m


def offset_part(m, part, d):
    """Move every vertex of one part (lathes are built on the axis)."""
    for i, p in enumerate(m.verts):
        if m.vpart[i] == part:
            v = m.verts[i]
            m.verts[i] = (v[0] + d[0], v[1] + d[1], v[2] + d[2])


def build_feather():
    m = Mesh("Feather")
    m.part = 3
    m.tube([(0, 0, 0), (0.001, 0.05, 0), (0.002, 0.085, 0)], [0.0035, 0.0045, 0.004], 4)
    # the vane: two halves either side of the shaft, barbs swept toward the tip, one split
    rows = 12
    y0, y1 = 0.07, 0.355

    def spine(s):
        return (0.002 + 0.03 * s ** 1.6, y0 + (y1 - y0) * s, 0.0)

    def width(s):
        return 0.04 * math.sin(math.pi * min(1, s * 1.15) ** 0.7) ** 0.9 * (1 - 0.25 * s) + 0.002

    def part_of(s):
        y = y0 + (y1 - y0) * s
        if y > 0.262:
            return 2
        return 1 if 0.165 < y < 0.198 or 0.222 < y < 0.236 else 0

    for r in range(rows):
        s0, s1 = r / rows, (r + 1) / rows
        m.part = part_of((s0 + s1) / 2)
        for side in (-1, 1):
            def edge(s, k):
                c = spine(s)
                w = width(s) * k
                return (c[0] + side * w, c[1] - 0.03 * k * (1 - s * 0.5), (0.004 * k * (1 - k)) * 4)
            split = side > 0 and r == 5
            for k0, k1 in ((0.0, 0.5), (0.5, 1.0)):
                if split and k0 > 0:
                    # the split: the outer barbs part a little up the vane
                    a, b = edge(s0, k0), edge(s0, k1)
                    m.quad(a, b, (b[0] + 0.004, b[1] - 0.01, b[2]), (a[0] + 0.001, a[1] - 0.004, a[2]))
                    continue
                m.quad(edge(s0, k0), edge(s0, k1), edge(s1, k1), edge(s1, k0))
    m.part = 3
    m.tube([spine(0.0), spine(0.5), spine(0.97)], [0.0034, 0.0028, 0.0012], 4, rot=math.pi / 4, caps=(False, False))
    return m


# ------------------------------------------------------------------ build and export


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


BUDGET = {"Board": 600, "Roll": 400, "Lamp": 300}


def main():
    clear()
    meshes = [build_board(), build_roll(), build_fringe(), build_tassel(), *build_picks(), build_lamp(), build_spyglass(),
              build_flute(), build_bedroll(), build_rod(), build_rope(), build_boot(), build_feather()]
    # the boot's cuff and wrappings were turned on the axis: put them on the shaft
    boot = next(m for m in meshes if m.name == "Boot")
    offset_part(boot, 3, (0, 0, -0.032))
    obs = [m.object() for m in meshes]
    bpy.ops.object.select_all(action="DESELECT")
    for ob in obs:
        ob.select_set(True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_attributes=True,
        export_normals=False,
        export_texcoords=False,
        export_materials="NONE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    for m in meshes:
        cap = BUDGET.get(m.name, 300 if m.name.startswith("Pick") else 200)
        flag = "" if m.tris() <= cap else f"  OVER {cap}"
        print(f"EQUIPMENT {m.name}: {m.tris()} triangles{flag}")
    print(f"EQUIPMENT wrote {os.path.abspath(OUT)} ({os.path.getsize(OUT)} bytes)")
    return meshes, obs


if __name__ == "__main__":
    main()
