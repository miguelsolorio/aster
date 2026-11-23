"""Five design directions for the townsfolk and miners, each in the wanderer's family (a round head
with a clean white disc face). A design comparison only: nothing here is read by the game.

    blender --background --python tools/blender/folk_variants/build.py -- --variant 3 --out DIR
    blender --background --python tools/blender/folk_variants/build.py -- --variant all --out DIR
    blender --background --python tools/blender/folk_variants/build.py -- --sheet DIR

Each direction is one function, VARIANTS[n](s, kid, miner) -> Mesh, built in the game's frame
(metres, +y up, facing +z, feet at y = 0) with sRGB vertex colours, so the chosen one can later be
ported to townsfolk.py. Silhouettes follow people.ts: 0 wide, 1 slim/tall hood, 2 bent elder with a
cane, 3 straight column with headwear (also the miner's). A child is silhouette 0 at 0.6 scale.
The miner wears MINER_CLOTH / MINER_HEM and carries the pick (equipment.ts pick 2) and the lamp.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
WANDERER_GLB = os.path.normpath(os.path.join(HERE, "..", "..", "..", "public", "art", "wanderer.glb"))

# ------------------------------------------------------------------ palette (trade city, people.ts)
WHITE = (0.95, 0.93, 0.88)
DARK = (0.2, 0.17, 0.16)
IRON = (0.32, 0.31, 0.33)
PALE = (0.8, 0.68, 0.5)
PANE = (1.0, 0.84, 0.5)
STRAW = (0.88, 0.74, 0.44)
LEATHER = (0.45, 0.29, 0.17)
PAL = {
    0: dict(top=(0.7, 0.5, 0.26), hem=(0.62, 0.42, 0.2), sec=(0.6, 0.3, 0.2), acc=(0.22, 0.44, 0.44)),
    1: dict(top=(0.96, 0.28, 0.5), hem=(0.98, 0.62, 0.2), sec=(0.4, 0.22, 0.34), acc=(0.84, 0.78, 0.66)),
    2: dict(top=(0.84, 0.78, 0.66), hem=(0.74, 0.68, 0.56), sec=(0.22, 0.44, 0.44), acc=(0.6, 0.3, 0.2)),
    3: dict(top=(0.26, 0.3, 0.5), hem=(0.22, 0.25, 0.42), sec=(0.98, 0.8, 0.22), acc=(0.86, 0.16, 0.56)),
    "kid": dict(top=(0.98, 0.8, 0.22), hem=(0.94, 0.3, 0.46), sec=(0.22, 0.44, 0.44), acc=(0.96, 0.28, 0.5)),
    "miner": dict(top=(1.0, 0.32, 0.0), hem=(1.0, 0.9, 0.05), sec=LEATHER, acc=DARK),
}


def pal(s, kid, miner):
    return PAL["miner"] if miner else PAL["kid"] if kid else PAL[s]


# ------------------------------------------------------------------ small maths


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


def mixc(a, b, t):
    return tuple(mix(a[k], b[k], t) for k in range(3))


def mulc(a, s):
    return tuple(min(1.0, x * s) for x in a)


def lerp_table(tab, v):
    if v <= tab[0][0]:
        return tab[0][1]
    for (a, x), (b, y) in zip(tab, tab[1:]):
        if v <= b:
            return mix(x, y, (v - a) / (b - a))
    return tab[-1][1]


def srgb_to_lin(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def gb(p):
    """Game (x, y up, z forward) to Blender (x, y back, z up)."""
    return (p[0], -p[2], p[1])


# ------------------------------------------------------------------ mesh builder


class Mesh:
    def __init__(self):
        self.v = []
        self.c = []
        self.f = []
        self.props = 0  # triangles of carried things the game draws as meshes of their own

    def vert(self, p, c):
        self.v.append(Vector(p))
        self.c.append(tuple(c))
        return len(self.v) - 1

    def face(self, idx, inside):
        """Add a polygon, wound so its normal points away from `inside`."""
        n = Vector()
        pts = [self.v[i] for i in idx]
        for a, b in zip(pts, pts[1:] + pts[:1]):
            n += a.cross(b)
        cen = sum(pts, Vector()) / len(pts)
        if n.dot(cen - Vector(inside)) < 0:
            idx = idx[::-1]
        self.f.append(tuple(idx))

    def tris(self):
        return sum(len(f) - 2 for f in self.f)

    def sheet(self, rows, col, inside, closed=True, cap0=None, cap1=None, cap_col=None):
        """Rows of points joined into quads; `col` is an rgb or fn(i, j, p) -> rgb; `inside` a point
        per row the surface faces away from; cap0 / cap1 close the first / last row to a pole."""
        cf = col if callable(col) else (lambda i, j, p: col)
        ids = [[self.vert(p, cf(i, j, Vector(p))) for j, p in enumerate(row)] for i, row in enumerate(rows)]
        n = len(rows[0])
        m = n if closed else n - 1
        for i in range(len(rows) - 1):
            ins = (Vector(inside[i]) + Vector(inside[i + 1])) / 2
            for j in range(m):
                j1 = (j + 1) % n
                self.face([ids[i][j], ids[i][j1], ids[i + 1][j1], ids[i + 1][j]], ins)
        for cap, row, ins in ((cap0, 0, 1), (cap1, -1, -2)):
            if cap is None:
                continue
            ref = (Vector(inside[row]) + Vector(inside[ins])) / 2 if len(rows) > 1 else Vector(inside[row])
            cc = cap_col or cf(0 if row == 0 else len(rows) - 1, 0, Vector(cap))
            c = self.vert(cap, cc)
            for j in range(m):
                self.face([c, ids[row][j], ids[row][(j + 1) % n]], ref)
        return ids

    def lathe(self, prof, col, n=16, c=(0, 0, 0), zs=1.0, arc=None, cap0=False, cap1=False, wob=None, yof=None):
        """Revolve a profile of (r, y[, dz[, xs]]) round the vertical through c. arc: only the back,
        out to this half-angle (an open cloak). wob(a, i) scales the radius, yof(a, i) shifts y."""
        rows, ins = [], []
        cnt = n if arc is None else n + 1
        for i, pr in enumerate(prof):
            r, y = pr[0], pr[1]
            dz = pr[2] if len(pr) > 2 else 0.0
            xs = pr[3] if len(pr) > 3 else 1.0
            row = []
            for j in range(cnt):
                a = j / n * TAU if arc is None else math.pi - arc + 2 * arc * j / n
                rr = r * (wob(a, i) if wob else 1.0)
                yy = y + (yof(a, i) if yof else 0.0)
                row.append((c[0] + math.sin(a) * rr * xs, c[1] + yy, c[2] + dz + math.cos(a) * rr * zs))
            rows.append(row)
            ins.append((c[0], c[1] + y, c[2] + dz))
        p0 = (c[0], c[1] + prof[0][1], c[2] + (prof[0][2] if len(prof[0]) > 2 else 0)) if cap0 else None
        p1 = (c[0], c[1] + prof[-1][1], c[2] + (prof[-1][2] if len(prof[-1]) > 2 else 0)) if cap1 else None
        if cap0 is not True and cap0:
            p0 = cap0
        if cap1 is not True and cap1:
            p1 = cap1
        return self.sheet(rows, col, ins, closed=arc is None, cap0=p0, cap1=p1)

    def ball(self, c, rx, ry, rz, col, n=10, rows=5):
        prof = []
        for j in range(1, rows + 1):
            a = j / (rows + 1) * math.pi
            prof.append((math.sin(a), -math.cos(a) * ry))
        rows_ = []
        ins = []
        for r, y in prof:
            rows_.append([(c[0] + math.sin(k / n * TAU) * r * rx, c[1] + y, c[2] + math.cos(k / n * TAU) * r * rz) for k in range(n)])
            ins.append(c)
        self.sheet(rows_, col, [c] * len(rows_), cap0=(c[0], c[1] - ry, c[2]), cap1=(c[0], c[1] + ry, c[2]))

    def tube(self, path, radii, col, n=6, caps=True, closed_path=False, flat=1.0, side=None):
        path = [Vector(p) for p in path]
        rows = []
        L = len(path)
        for i, p in enumerate(path):
            if closed_path:
                a, b = path[(i - 1) % L], path[(i + 1) % L]
            else:
                a, b = path[max(0, i - 1)], path[min(L - 1, i + 1)]
            t = (b - a).normalized()
            ref = Vector(side) if side else (Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0)))
            z = (ref - t * ref.dot(t)).normalized()
            x = t.cross(z)
            r = radii[i]
            rows.append([tuple(p + x * (math.sin(k / n * TAU) * r) + z * (math.cos(k / n * TAU) * r * flat)) for k in range(n)])
        if closed_path:
            rows.append(rows[0])
            # joined back on itself: reuse the first ring's vertices by building quads manually
            cf = col if callable(col) else (lambda i, j, q: col)
            ids = [[self.vert(q, cf(i, j, Vector(q))) for j, q in enumerate(row)] for i, row in enumerate(rows[:-1])]
            for i in range(L):
                i1 = (i + 1) % L
                ins = (path[i] + path[i1]) / 2
                for j in range(n):
                    j1 = (j + 1) % n
                    self.face([ids[i][j], ids[i][j1], ids[i1][j1], ids[i1][j]], ins)
            return
        self.sheet(rows, col, [tuple(p) for p in path], cap0=tuple(path[0]) if caps else None, cap1=tuple(path[-1]) if caps else None)

    def box(self, c, size, col):
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        ids = [self.vert((c[0] + sx * hx, c[1] + sy * hy, c[2] + sz * hz), col) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([ids[k] for k in q], c)

    def deform(self, fn, start=0, end=None):
        for i in range(start, len(self.v) if end is None else end):
            self.v[i] = Vector(fn(self.v[i]))


# ------------------------------------------------------------------ the round head and its disc


class Head:
    """A round head centred at c, radius R, its face looking along `ax` (tipped a little down).
    Directions round the face axis: theta from the axis, phi round it (0 = +x, pi/2 = up)."""

    def __init__(self, c, R, drop=0.12, half=0.9):
        self.c = Vector(c)
        self.R = R
        self.ax = Vector((0, -drop, 1)).normalized()
        self.e1 = Vector((1, 0, 0))
        self.e2 = self.ax.cross(self.e1).normalized()
        if self.e2.y < 0:
            self.e2 = -self.e2
        self.half = half

    def d(self, theta, phi):
        return (self.ax * math.cos(theta) + (self.e1 * math.cos(phi) + self.e2 * math.sin(phi)) * math.sin(theta)).normalized()

    def ball(self, m, col, n=12, rows=7, ys=1.0):
        m.ball(tuple(self.c), self.R, self.R * ys, self.R, col, n, rows)

    def face(self, m, rows=3, n=18, lift=0.005, dist=None, col=WHITE, flat=0.0):
        """The white disc: a slightly flattened cap of the head out to `half` from the face axis."""
        rs = []
        for k in range(1, rows + 1):
            th = self.half * k / rows
            row = []
            for j in range(n):
                dd = self.d(th, j / n * TAU)
                r = dist(dd) if dist else self.R
                # flatten toward the disc's own plane, keeping the rim on the sphere
                rr = mix(r, r * math.cos(self.half) / max(1e-4, dd.dot(self.ax)), flat * (1 - (th / self.half) ** 2)) if flat else r
                row.append(tuple(self.c + dd * (rr + lift)))
            rs.append(row)
        r0 = dist(self.ax) if dist else self.R
        pole = self.c + self.ax * (mix(r0, r0 * math.cos(self.half), flat) + lift)
        m.sheet(rs, col, [tuple(self.c)] * rows, cap0=tuple(pole))

    def shell(self, m, col, theta0, rfn, nphi=16, rows=6, theta1=math.pi):
        """A hood or wrap round the head, open at the face from theta0, closed behind at theta1."""
        rs = []
        ths = [mix(theta0, theta1, (k / rows) ** 0.9) for k in range(rows)]
        for i, th in enumerate(ths):
            row = []
            for j in range(nphi):
                dd = self.d(th, j / nphi * TAU)
                row.append(tuple(self.c + dd * rfn(dd, th, j / nphi * TAU)))
            rs.append(row)
        back = self.d(theta1, 0)
        cf = col if callable(col) else (lambda i, j, p: col)
        return m.sheet(rs, cf, [tuple(self.c)] * rows, cap1=tuple(self.c + back * rfn(back, theta1, 0)))

    def rim(self, m, col, theta, dist, thick, n=18, sides=5, tfn=None):
        """A soft roll round the face opening at angle theta, `dist` out from the centre."""
        path = []
        rad = []
        for j in range(n):
            phi = j / n * TAU
            path.append(tuple(self.c + self.d(theta, phi) * dist))
            rad.append(thick * (tfn(phi) if tfn else 1.0))
        rows = []
        P = [Vector(p) for p in path]
        for j in range(n):
            t = (P[(j + 1) % n] - P[(j - 1) % n]).normalized()
            out = (P[j] - self.c).normalized()
            b = t.cross(out).normalized()
            rows.append([tuple(P[j] + out * math.cos(k / sides * TAU) * rad[j] + b * math.sin(k / sides * TAU) * rad[j]) for k in range(sides)])
        cf = col if callable(col) else (lambda i, jj, p: col)
        ids = [[m.vert(q, cf(i, k, Vector(q))) for k, q in enumerate(row)] for i, row in enumerate(rows)]
        for j in range(n):
            j1 = (j + 1) % n
            ins = (P[j] + P[j1]) / 2
            for k in range(sides):
                k1 = (k + 1) % sides
                m.face([ids[j][k], ids[j][k1], ids[j1][k1], ids[j1][k]], ins)

    def top_y(self, r=None):
        """Height of the disc's top edge above the head centre."""
        dd = self.d(self.half, math.pi / 2)
        return dd.y * (r or self.R)


# ------------------------------------------------------------------ shared body parts


SHOULDER_X = [(0.6, 1.0), (0.72, 1.07), (0.82, 1.24), (0.88, 1.4), (0.92, 1.44), (0.965, 1.28), (1.0, 1.0)]


def grad(P, y0, y1, banded=False):
    def f(i, j, p):
        t = smoothstep(y0, y1, p.y)
        c = mixc(P["hem"], P["top"], t)
        if banded and y0 + 0.02 < p.y < y0 + 0.24:
            c = P["hem"] if int((p.y - y0) / 0.07) % 2 == 0 else P["top"]
        return c
    return f


def arm(m, sh, hand, sleeve, r=(0.04, 0.046, 0.054), hand_col=WHITE, hr=0.036, n=6, elbow_out=0.03):
    sh, hand = Vector(sh), Vector(hand)
    d = (hand - sh)
    wrist = sh + d * 0.86
    mid = sh + d * 0.5 + Vector((math.copysign(elbow_out, sh.x), 0, -0.01))
    m.tube([sh, mid, wrist], list(r), sleeve, n)
    m.ball(tuple(sh + d * 1.0), hr, hr * 1.25, hr, hand_col, 6, 3)


def legs(m, top, col=DARK, sx=0.068, shoe=DARK, r=0.024):
    for x in (sx, -sx):
        m.tube([(x, 0.05, 0.0), (x, top * 0.5, 0.0), (x, top, -0.005)], [r, r * 1.08, r * 1.25], col, 6)
        m.ball((x, 0.03, 0.03), 0.034, 0.032, 0.064, shoe, 6, 3)


def feet(m, col=DARK, sx=0.075, y=0.03, z=0.06, r=0.04):
    for x in (sx, -sx):
        m.ball((x, y, z), r, r * 0.8, r * 1.5, col, 6, 3)


def cane(m, hand, col=(0.5, 0.36, 0.22), top=None):
    hx, hy, hz = hand
    m.tube([(hx, 0.0, hz), (hx, hy * 0.5, hz), (hx, hy - 0.02, hz), (hx, hy + 0.03, hz - 0.03), (hx, hy + 0.01, hz - 0.07)], [0.012, 0.014, 0.015, 0.015, 0.013], col, 6)


def staff(m, hand, h=1.85, col=(0.5, 0.36, 0.22), cloth=None):
    hx, hy, hz = hand
    m.tube([(hx, 0.0, hz), (hx, hy, hz), (hx, h, hz - 0.02)], [0.014, 0.015, 0.013], col, 6)
    if cloth:
        m.tube([(hx, h - 0.08, hz - 0.02), (hx + 0.02, h - 0.2, hz - 0.06), (hx + 0.01, h - 0.34, hz - 0.08)], [0.02, 0.028, 0.01], cloth, 5)


def pick(m, hand):
    """equipment.ts pick 2 (the plain two-ended pick) at 1.2x, held upright in the hand."""
    hx, hy, hz = hand
    s = 1.2
    base = Vector((hx, hy - 0.08 * s, hz))
    top = Vector((hx, hy + 0.32 * s, hz - 0.01))
    m.tube([base, (base + top) / 2, top], [0.016 * s, 0.015 * s, 0.017 * s], PALE, 6)
    hy2 = top.y - 0.01
    m.tube([(hx, hy2 - 0.06 * s, top.z - 0.18 * s), (hx, hy2 - 0.01 * s, top.z - 0.09 * s), (hx, hy2 + 0.01 * s, top.z), (hx, hy2 - 0.01 * s, top.z + 0.09 * s), (hx, hy2 - 0.06 * s, top.z + 0.18 * s)],
           [0.003, 0.014 * s, 0.022 * s, 0.014 * s, 0.003], IRON, 4)


def lamp(m, at, s=1.3):
    """equipment.ts lampGeometry (at 1.5x in game) hanging from `at`: iron ring, horn panes."""
    x, y, z = at
    m.tube([(x - 0.03 * s, y - 0.01 * s, z), (x - 0.03 * s, y + 0.03 * s, z), (x + 0.03 * s, y + 0.03 * s, z), (x + 0.03 * s, y - 0.01 * s, z)], [0.006 * s] * 4, IRON, 4, caps=False)
    m.lathe([(0.05 * s, -0.05 * s), (0.04 * s, -0.01 * s)], IRON, n=6, c=(x, y, z), cap1=True)
    m.box((x, y - 0.105 * s, z), (0.07 * s, 0.11 * s, 0.07 * s), PANE)
    m.box((x, y - 0.17 * s, z), (0.095 * s, 0.022 * s, 0.095 * s), IRON)


def brow_lamp(m, head, col=IRON):
    """A small lamp on the brow, above the disc."""
    d = head.d(head.half + 0.32, math.pi / 2)
    p = head.c + d * (head.R + 0.03)
    m.lathe([(0.035, -0.03), (0.04, 0.0), (0.035, 0.035)], col, n=8, c=tuple(p), cap0=True, cap1=False)
    m.ball(tuple(p + Vector((0, 0.0, 0.035))), 0.03, 0.03, 0.012, PANE, 8, 3)


def carry(m, s, miner, hands, P):
    """What the person holds: the elder's cane, the miner's pick and lamp."""
    if s == 2 and not miner:
        cane(m, hands[1])
    if miner:
        t0 = m.tris()
        pick(m, hands[1])
        lamp(m, (hands[0][0], hands[0][1] - 0.03, hands[0][2]))
        m.props = m.tris() - t0


def elder_bend(m, start=0, k=0.32, y0=0.72):
    def fn(p):
        t = max(0.0, p.y - y0)
        return (p.x, p.y - 0.12 * t * t, p.z + k * t * t)
    m.deform(fn, start)


# ================================================================== 1  Kin
# The wanderer's own head (hood sphere, disc face, rolled rim, hood point down the back) on every
# person, his pleated dress and open cloak; silhouettes differ by cloak cut, colour and one
# accessory. Headwear (the turban) is worn over the round hood.

K_C = Vector((0, 1.56, -0.03))
K_HR = 0.155


def kin_head(m, P, hood_col, turban=None):
    h = Head(K_C, K_HR, drop=0.11, half=math.acos(0.6))
    h.ball(m, hood_col, 12, 7, ys=1.03)
    h.face(m, rows=3, n=16, lift=0.006)
    h.rim(m, mulc(hood_col, 0.9), h.half + 0.11, K_HR + 0.014, 0.017, n=16, sides=4, tfn=lambda phi: 0.75 + 0.45 * max(0.0, math.sin(phi)))
    # the hood point: lifts behind the crown and hangs down the back
    ctrl = [(0, 0.06, -0.07), (0, 0.105, -0.125), (0, 0.06, -0.168), (0, -0.02, -0.168), (0, -0.1, -0.15)]
    m.tube([tuple(K_C + Vector(p)) for p in ctrl], [0.075, 0.055, 0.042, 0.03, 0.004], hood_col, 7, flat=0.7, side=(1, 0, 0))
    if turban:
        rows = [(0.118, 0.105), (0.15, 0.13), (0.158, 0.165), (0.145, 0.205), (0.1, 0.235)]
        m.lathe([(r, y, -0.045) for r, y in rows], turban, n=12, c=tuple(K_C), cap1=(K_C.x, K_C.y + 0.245, K_C.z - 0.045), cap0=True,
                wob=lambda a, i: 1 + 0.07 * math.cos(2 * a + 1.7 * i))
    return h


def kin_dress_r(y):
    v = (1.42 - y) / (1.42 - 0.36)
    return 0.07 + (0.31 - 0.07) * v ** 1.45


def v1(s, kid=False, miner=False):
    P = pal(s, kid, miner)
    m = Mesh()
    hem = 0.36 if s != 2 else 0.4
    rows = [hem, 0.5, 0.72, 0.95, 1.16, 1.32, 1.42]
    wide = {0: 1.1, 1: 0.86, 2: 1.0, 3: 0.92}[s]
    prof = [(kin_dress_r(y) * wide, y) for y in rows]
    m.lathe(prof, grad(P, hem, 1.2, banded=miner), n=18, zs=0.88, cap1=True,
            wob=lambda a, i: 1 + 0.1 * math.cos(6 * a) * max(0.0, 1 - i / 4),
            yof=lambda a, i: -0.035 * (0.5 + 0.5 * math.sin(7 * a)) if i == 0 else 0.0)
    legs(m, hem + 0.05)
    # the open cloak: back and sides only, cut per silhouette
    cut = {0: (0.74, 0.34, 2.2), 1: (0.2, 0.34, 2.5), 2: (1.0, 0.3, 2.6), 3: (0.56, 0.27, 2.1)}[s]
    chem, cr, carc = cut
    cy = [chem, mix(chem, 1.45, 0.4), mix(chem, 1.45, 0.75), 1.38, 1.45]
    cp = [(mix(cr, 0.105, smoothstep(chem, 1.45, y) ** 0.8) * (1.18 if y in (1.38,) else 1.0), y, -0.01) for y in cy]
    cloak_col = P["sec"]
    m.lathe(cp, lambda i, j, p: mulc(cloak_col, 0.82 + 0.18 * smoothstep(chem, 1.4, p.y)), n=10, zs=0.92, arc=carc,
            yof=lambda a, i: -0.03 * (0.5 + 0.5 * math.sin(9 * a)) if i == 0 else 0.0)
    # arms and hands
    hands = [(0.2, 0.88, 0.07), (-0.2, 0.88, 0.07)]
    if s == 2 and not miner:
        hands[1] = (-0.27, 0.97, 0.2)
    if miner:
        hands[1] = (-0.22, 0.9, 0.14)
    for sx, hd in zip((1, -1), hands):
        arm(m, (sx * 0.13, 1.3, 0.0), hd, mulc(P["top"], 0.9), r=(0.032, 0.036, 0.042))
    # accessories
    if s == 0 and not kid:
        r = kin_dress_r(0.98) * wide * 1.1
        m.lathe([(r, 0.95), (r * 1.04, 0.98), (r, 1.01)], P["acc"], n=12, zs=0.88)
        m.tube([(0.07, 0.96, r * 0.9), (0.09, 0.84, r * 1.0), (0.1, 0.72, r * 1.1)], [0.028, 0.03, 0.02], P["acc"], 4, flat=0.4)
    if s == 1:
        for sx in (1, -1):
            m.tube([(sx * 0.1, 1.42, -0.04), (sx * 0.1, 1.38, 0.07), (sx * 0.1, 1.15, 0.11), (sx * 0.1, 0.85, 0.15)], [0.034, 0.036, 0.036, 0.034], P["acc"], 4, flat=0.35, side=(0, 0, 1))
    turban = P["sec"] if s == 3 and not miner else None
    hood_col = P["top"] if s == 3 else cloak_col
    if miner:
        hood_col = LEATHER
    start = len(m.v)
    head = kin_head(m, P, hood_col, turban)
    if s == 2 and not miner:
        elder_bend(m)
        staff(m, hands[1], 1.75, cloth=P["acc"])
    if miner:
        brow_lamp(m, head)
    carry(m, s, miner, hands, P) if miner else None
    return m


# ================================================================== 2  Big round heads
# A figurine: a large round head (a soft hood round the white disc) on a short bell robe, stubby
# arms, tiny feet. Headwear is cut down to bands, a pompom, small caps.

def v2(s, kid=False, miner=False):
    P = pal(s, kid, miner)
    m = Mesh()
    R = 0.215 if not kid else 0.235
    hem_r = {0: 0.33, 1: 0.24, 2: 0.3, 3: 0.24}[s]
    top_y = {0: 0.84, 1: 0.9, 2: 0.74, 3: 0.92}[s]
    prof = [(hem_r, 0.07), (hem_r * 1.04, 0.12), (hem_r * 0.96, 0.24), (hem_r * 0.82, 0.42), (mix(hem_r, 0.15, 0.6), mix(0.42, top_y, 0.6)), (0.15, top_y - 0.05), (0.09, top_y)]
    m.lathe(prof, grad(P, 0.08, top_y, banded=miner), n=14, zs=0.9, cap0=(0, 0.06, 0), cap1=True)
    m.lathe([(hem_r * 1.06, 0.075), (hem_r * 1.08, 0.11), (hem_r * 1.0, 0.13)], mulc(P["hem"], 0.75) if not miner else DARK, n=14, zs=0.9)
    feet(m, DARK, sx=0.075, y=0.03, z=hem_r * 0.75, r=0.04)
    hc = (0, top_y + R * 0.88, 0.02)
    h = Head(hc, R, drop=0.14, half=0.86)
    hood = P["sec"] if s != 2 else P["acc"]
    if miner:
        hood = LEATHER
    hands = [(0.27, top_y - 0.28, 0.1), (-0.27, top_y - 0.28, 0.1)]
    if s == 2 and not miner:
        hands[1] = (-0.28, top_y - 0.2, 0.2)
    for sx, hd in zip((1, -1), hands):
        arm(m, (sx * 0.15, top_y - 0.08, 0.0), hd, mulc(P["top"], 0.92), r=(0.045, 0.05, 0.055), hr=0.045, elbow_out=0.02)
    start = len(m.v)
    h.ball(m, hood, 14, 8)
    h.face(m, rows=3, n=20, lift=0.006)
    ty = h.top_y()
    if s == 0:
        # a band tipped round the crown, higher at the front, with two knot tails behind
        nb = 16
        path = []
        for j in range(nb):
            a = j / nb * TAU
            yy = mix(0.2, 0.86, 0.5 + 0.5 * math.cos(a)) * R
            rr = math.sqrt(max(0.0, R * R - yy * yy)) + 0.006
            path.append((hc[0] + math.sin(a) * rr, hc[1] + yy, hc[2] + math.cos(a) * rr))
        m.tube(path, [0.02] * nb, P["acc"], 5, closed_path=True)
        bk = Vector((hc[0], hc[1] + 0.2 * R, hc[2] - R - 0.01))
        for sx in (1, -1):
            m.tube([bk, bk + Vector((sx * 0.05, -0.07, -0.03)), bk + Vector((sx * 0.08, -0.16, -0.03))], [0.022, 0.02, 0.006], P["acc"], 4, flat=0.4)
    elif s == 1:
        # a small knitted cap at the crown and a pompom
        cap = [(R * 0.82, R * 0.6, -0.02), (R * 0.78, R * 0.72, -0.02), (R * 0.62, R * 0.86, -0.025), (R * 0.36, R * 0.98, -0.03)]
        m.lathe(cap, P["acc"], n=14, c=hc, cap1=(hc[0], hc[1] + R * 1.04, hc[2] - 0.03), wob=lambda a, i: 1 + (0.06 if i == 0 else 0.03) * (1 if math.cos(a) < 0.3 else 0.6))
        m.ball((hc[0], hc[1] + R * 1.16, hc[2] - 0.035), 0.055, 0.055, 0.055, P["top"], 8, 4)
    elif s == 2:
        # a soft shawl over the back of the head and a skullcap
        m.lathe([(R * 0.62, R * 0.78, -0.03), (R * 0.56, R * 0.86, -0.03), (R * 0.36, R * 0.97, -0.03)], P["sec"], n=12, c=hc, cap1=(hc[0], hc[1] + R * 1.02, hc[2] - 0.03))
        m.tube([(0.16, top_y + 0.0, 0.05), (0.0, top_y - 0.03, 0.2), (-0.16, top_y + 0.0, 0.05), (-0.13, top_y + 0.02, -0.12), (0.13, top_y + 0.02, -0.12)], [0.045] * 5, P["sec"], 6, closed_path=True)
    elif s == 3 or miner:
        if miner:
            # a leather cap with a brow lamp
            m.lathe([(R * 1.02, R * 0.55, -0.01), (R * 0.94, R * 0.72, -0.015), (R * 0.68, R * 0.9, -0.02), (R * 0.3, R * 1.01, -0.02)], DARK, n=14, c=hc, cap1=(hc[0], hc[1] + R * 1.03, hc[2] - 0.02),
                    wob=lambda a, i: 1.0 if math.cos(a) < 0.55 else 1.0 + 0.04 * (i == 0))
            brow_lamp(m, Head(hc, R * 1.0, drop=0.14, half=0.86 + 0.05))
        else:
            # a rolled turban crown sitting on top
            rows = [(R * 0.7, R * 0.72), (R * 0.82, R * 0.82), (R * 0.78, R * 0.95), (R * 0.6, R * 1.06), (R * 0.32, R * 1.12)]
            m.lathe([(r, y, -0.02) for r, y in rows], P["sec"], n=14, c=hc, cap0=True, cap1=(hc[0], hc[1] + R * 1.14, hc[2] - 0.02), wob=lambda a, i: 1 + 0.05 * math.cos(3 * a + i * 1.3))
            m.ball((hc[0], hc[1] + R * 0.86, hc[2] + R * 0.78), 0.025, 0.03, 0.02, P["acc"], 6, 3)
    if s == 2 and not miner:
        elder_bend(m, k=0.14, y0=0.4)
        cane(m, hands[1])
    if miner:
        carry(m, s, miner, hands, P)
    return m


# ================================================================== 3  Hooded mantles
# Everyone wears a short hooded mantle like the wanderer's cloak over a long coloured robe; the
# hood shape is the silhouette: point back, point up, deep cowl, rolled brim. Miners: a leather
# hood with a lamp on the brow.

M_C = Vector((0, 1.555, 0.0))
M_R = 0.13


def v3(s, kid=False, miner=False):
    P = pal(s, kid, miner)
    m = Mesh()
    hem_r = {0: 0.34, 1: 0.25, 2: 0.3, 3: 0.22}[s]
    rows = [0.08, 0.14, 0.3, 0.55, 0.8, 1.05, 1.25, 1.42]
    prof = [(mix(hem_r, 0.09, ((y - 0.08) / 1.34) ** (0.9 if s != 3 else 1.6)), y) for y in rows]
    m.lathe(prof, grad(P, 0.1, 1.1, banded=miner), n=14, zs=0.88, cap0=(0, 0.06, 0), cap1=True,
            wob=lambda a, i: 1 + 0.07 * math.cos(6 * a) * max(0.0, 1 - i / 4))
    feet(m, DARK, sx=0.07, y=0.035, z=hem_r * 0.8, r=0.035)
    mant = LEATHER if miner else P["sec"]
    mhem = {0: 1.0, 1: 0.98, 2: 0.82, 3: 1.06}[s]
    mr = {0: 0.34, 1: 0.29, 2: 0.33, 3: 0.27}[s]
    mp = [(mr, mhem), (mr * 0.9, mix(mhem, 1.4, 0.4)), (mr * 0.7, mix(mhem, 1.4, 0.75)), (0.17, 1.4), (0.12, 1.45)]
    m.lathe(mp, lambda i, j, p: mulc(mant, 0.85 + 0.15 * smoothstep(mhem, 1.4, p.y)), n=14, zs=0.9,
            yof=lambda a, i: -0.035 * (0.5 + 0.5 * math.cos(7 * a)) if i == 0 else 0.0)
    hands = [(0.2, mhem - 0.06, 0.14), (-0.2, mhem - 0.06, 0.14)]
    if s == 2 and not miner:
        hands[1] = (-0.27, 0.93, 0.22)
    if miner:
        hands[1] = (-0.22, 0.92, 0.16)
    for sx, hd in zip((1, -1), hands):
        arm(m, (sx * 0.15, mhem + 0.08, 0.04), hd, mulc(P["top"], 0.9), r=(0.035, 0.04, 0.045))
    h = Head(M_C, M_R, drop=0.12, half=0.88)
    h.ball(m, mulc(mant, 0.55), 12, 7)
    h.face(m, rows=3, n=18, lift=0.006)
    th0 = h.half + 0.1
    hood = mant
    if s == 1 and not miner:
        up = Vector((0, 1, -0.45)).normalized()
        h.shell(m, hood, th0, lambda dd, th, phi: M_R + 0.03 + 0.25 * max(0.0, dd.dot(up)) ** 4, nphi=16, rows=7)
        h.rim(m, mulc(hood, 0.9), th0, M_R + 0.032, 0.014, n=16, sides=4)
    elif s == 2 and not miner:
        # the deep cowl: its lip stands well out in front of the disc
        h.shell(m, hood, h.half + 0.05, lambda dd, th, phi: M_R + 0.03 + 0.045 * (1 - smoothstep(h.half, h.half + 0.8, th)) + 0.02 * max(0.0, -dd.y), nphi=16, rows=6)
        h.rim(m, mulc(hood, 0.88), h.half + 0.05, M_R + 0.075, 0.018, n=16, sides=4)
    elif s == 3 and not miner:
        # a rolled brim: a thick roll round the face
        h.shell(m, hood, th0, lambda dd, th, phi: M_R + 0.03, nphi=16, rows=6)
        h.rim(m, P["acc"], th0 + 0.08, M_R + 0.045, 0.034, n=18, sides=6)
    else:
        # point back (and the miner's leather hood)
        h.shell(m, hood, th0, lambda dd, th, phi: M_R + 0.03, nphi=16, rows=6)
        h.rim(m, mulc(hood, 0.9), th0, M_R + 0.032, 0.014, n=16, sides=4)
        if not miner:
            ctrl = [(0, 0.08, -0.1), (0, 0.11, -0.17), (0, 0.04, -0.2), (0, -0.05, -0.19), (0, -0.13, -0.17)]
            m.tube([tuple(M_C + Vector(p)) for p in ctrl], [0.07, 0.05, 0.04, 0.028, 0.004], hood, 7, flat=0.7, side=(1, 0, 0))
        else:
            brow_lamp(m, Head(M_C, M_R + 0.03, drop=0.12, half=h.half + 0.02))
    if s == 2 and not miner:
        elder_bend(m, k=0.22)
        cane(m, hands[1])
    if miner:
        carry(m, s, miner, hands, P)
    return m


# ================================================================== 4  Masks
# The disc stays round and plain, but each silhouette frames it: a turban wound round it, a veil
# hung below it, a brimmed hat shading it, a wide standing collar behind it. Layered colour.

def v4(s, kid=False, miner=False):
    P = pal(s, kid, miner)
    m = Mesh()
    hem_r = {0: 0.33, 1: 0.24, 2: 0.29, 3: 0.21}[s]
    under = P["acc"] if not miner else DARK
    rows = [0.16, 0.3, 0.6, 0.9, 1.2, 1.42]
    m.lathe([(mix(hem_r * 0.86, 0.09, ((y - 0.16) / 1.26) ** 1.1), y) for y in rows[:4]], under, n=12, zs=0.88, cap0=(0, 0.15, 0), cap1=True)
    legs(m, 0.22)
    ot = {0: 0.5, 1: 0.62, 2: 0.55, 3: 0.4}[s]
    orow = [ot, ot + 0.12, 0.8, 1.0, 1.2, 1.36, 1.44]

    def orad(y):
        v = (y - 0.16) / 1.26
        return mix(hem_r, 0.095, v ** 1.05) * 1.06

    m.lathe([(orad(y) * (1.08 if i == 0 else 1.0), y, 0.0, lerp_table(SHOULDER_X, (y - 0.16) / 1.26) ** 0.6) for i, y in enumerate(orow)],
            grad(P, ot, 1.2, banded=miner), n=12, zs=0.86, cap1=True,
            wob=lambda a, i: 1 + 0.1 * math.cos(6 * a) * max(0.0, 1 - i / 3),
            yof=lambda a, i: (0.05 * math.cos(a) - 0.03) if i == 0 and s in (0, 2) else 0.0)
    sy = 0.95 if s != 3 else 1.0
    r = orad(sy) * 1.06
    m.lathe([(r, sy - 0.03), (r * 1.03, sy), (r, sy + 0.03)], P["sec"] if not miner else DARK, n=14, zs=0.86)
    hands = [(0.2, 0.88, 0.08), (-0.2, 0.88, 0.08)]
    if s == 2 and not miner:
        hands[1] = (-0.27, 0.97, 0.2)
    if miner:
        hands[1] = (-0.22, 0.9, 0.14)
    for sx, hd in zip((1, -1), hands):
        arm(m, (sx * 0.14, 1.3, 0.0), hd, mulc(P["top"], 0.92))
    hc = Vector((0, 1.545, 0.02))
    R = 0.128
    h = Head(hc, R, drop=0.12, half=0.88)
    wrap = P["sec"]
    if miner:
        wrap = LEATHER
    h.ball(m, mulc(wrap, 0.6), 10, 6)
    h.face(m, rows=3, n=16, lift=0.006)
    if s == 0 and not miner:
        # the turban, wound right round the disc, chin included: rolls of cloth one outside the
        # next, thicker over the crown, a tail hanging behind
        tw = (P["acc"], P["top"] if kid else (0.88, 0.84, 0.74))
        h.shell(m, tw[0], h.half + 0.3, lambda dd, th, phi: R + 0.03 + 0.07 * max(0.0, dd.y) ** 1.5, nphi=12, rows=4)
        for k, (dth, dist, th_) in enumerate(((0.1, R + 0.03, 0.026), (0.42, R + 0.05, 0.034), (0.8, R + 0.055, 0.036))):
            h.rim(m, tw[k % 2], h.half + dth, dist, th_, n=12, sides=4, tfn=lambda phi: 0.7 + 0.9 * max(0.0, math.sin(phi)) ** 1.5)
        m.tube([hc + Vector((0.06, 0.02, -0.17)), hc + Vector((0.09, -0.12, -0.18)), hc + Vector((0.08, -0.3, -0.16))], [0.04, 0.035, 0.015], tw[1], 5, flat=0.4)
    elif s == 1 and not miner:
        # a headcloth and a veil hung below the disc to the chest
        h.shell(m, wrap, h.half + 0.08, lambda dd, th, phi: R + 0.025 + 0.06 * max(0.0, -dd.y) * max(0.0, -dd.z), nphi=14, rows=5)
        h.rim(m, P["acc"], h.half + 0.1, R + 0.028, 0.013, n=14, sides=4)
        bot = h.c + h.d(h.half + 0.1, -math.pi / 2) * (R + 0.03)
        vr = []
        for k in range(5):
            t = k / 4
            y = mix(bot.y, 1.16, t)
            w = mix(0.075, 0.11, t)
            vr.append([(math.sin(a) * w * 1.4, y, bot.z - 0.01 + 0.035 * t + math.cos(a) * w * 0.5 - w * 0.5) for a in [(-0.9 + 1.8 * q / 4) * 1.2 for q in range(5)]])
        m.sheet(vr, lambda i, j, p: mulc(P["acc"], 1.0 - 0.06 * i), [(0, mix(bot.y, 1.16, k / 4), bot.z - 0.2) for k in range(5)], closed=False)
        for q in range(5):
            m.ball(vr[-1][q], 0.012, 0.012, 0.012, P["sec"], 4, 2)
    elif s == 2 and not miner:
        # a wide brimmed hat over a headcloth, shading the disc
        h.shell(m, wrap, h.half + 0.08, lambda dd, th, phi: R + 0.02 + 0.05 * max(0.0, -dd.y) * max(0.0, -dd.z), nphi=14, rows=5)
        by = hc.y + h.top_y() + 0.012
        bdz = -0.01
        m.lathe([(0.115, by + 0.11, bdz), (0.125, by + 0.05, bdz), (0.135, by + 0.012, bdz), (0.33, by - 0.035, bdz), (0.34, by - 0.05, bdz), (0.13, by - 0.008, bdz)], STRAW, n=16, c=(0, 0, hc.z),
                cap0=(0, by + 0.12, hc.z + bdz), yof=lambda a, i: 0.06 * max(0.0, math.cos(a)) if i in (3, 4) else 0.0)
        m.lathe([(0.128, by + 0.012), (0.13, by + 0.04)], P["acc"], n=16, c=(0, 0, hc.z + bdz))
    else:
        # a wide standing collar behind the head, a small round cap (the miner's leather, a lamp)
        coll = P["sec"] if not miner else LEATHER
        cps = [(0.1, 1.38, -0.0), (0.14, 1.42, -0.01), (0.22, 1.5, -0.03), (0.28, 1.6, -0.05), (0.29, 1.66, -0.06)]
        m.lathe(cps, lambda i, j, p: coll if i < 4 else mulc(coll, 0.8), n=14, arc=2.0, zs=0.75)
        cap = [(R * 0.95, h.top_y() + 0.02, -0.02), (R * 0.86, h.top_y() + 0.055, -0.02), (R * 0.5, h.top_y() + 0.085, -0.02)]
        m.lathe(cap, P["acc"] if not miner else DARK, n=14, c=tuple(hc), cap0=True, cap1=(hc.x, hc.y + h.top_y() + 0.095, hc.z - 0.02))
        if miner:
            brow_lamp(m, Head(hc, R + 0.02, drop=0.12, half=h.half + 0.12))
    if s == 2 and not miner:
        elder_bend(m)
        cane(m, hands[1])
    if miner:
        carry(m, s, miner, hands, P)
    return m


# ================================================================== 5  Soft geometry
# Smooth cones and bells, sphere heads sat straight on them, round hats, little nub hands and no
# other detail: the wanderer's minimalism, very readable at distance.

def v5(s, kid=False, miner=False):
    P = pal(s, kid, miner)
    m = Mesh()
    # robe: a smooth cone or bell
    if s == 0:
        prof = [(0.36, 0.04), (0.37, 0.08), (0.3, 0.4), (0.21, 0.8), (0.13, 1.2), (0.08, 1.42)]
    elif s == 1:
        prof = [(0.25, 0.04), (0.255, 0.08), (0.2, 0.5), (0.145, 0.95), (0.1, 1.3), (0.075, 1.45)]
    elif s == 2:
        prof = [(0.3, 0.04), (0.31, 0.08), (0.3, 0.3), (0.26, 0.6), (0.18, 0.95), (0.08, 1.18)]
    else:
        prof = [(0.22, 0.04), (0.225, 0.08), (0.21, 0.5), (0.19, 0.95), (0.15, 1.3), (0.08, 1.43)]
    top_y = prof[-1][1]
    m.lathe(prof, grad(P, 0.1, top_y - 0.1, banded=miner), n=18, zs=0.92, cap0=(0, 0.035, 0), cap1=True)
    R = 0.15
    hc = Vector((0, top_y + R * 0.8, 0.02 if s != 2 else 0.1))
    if s == 2:
        hc = Vector((0, top_y + R * 0.6, 0.12))
    # nub hands, just out of the robe's sides
    def side_r(y):
        for (r0, y0), (r1, y1) in zip(prof, prof[1:]):
            if y0 <= y <= y1:
                return mix(r0, r1, (y - y0) / (y1 - y0))
        return prof[-1][0]
    hy = 0.86 if s != 2 else 0.72
    hands = [(side_r(hy) + 0.02, hy, 0.06), (-side_r(hy) - 0.02, hy, 0.06)]
    if s == 2 and not miner:
        hands[1] = (-0.3, 0.8, 0.2)
    if miner:
        hands[1] = (-0.21, 0.9, 0.14)
    for hd in hands:
        m.ball(hd, 0.05, 0.065, 0.05, WHITE, 8, 4)
    h = Head(hc, R, drop=0.12, half=0.9)
    h.ball(m, P["sec"] if not miner else LEATHER, 16, 9)
    h.face(m, rows=3, n=22, lift=0.006)
    ty = h.top_y()
    hat = P["sec"] if s != 1 else P["top"]
    if s == 0 and not kid:
        # a round dome cap on the back of the crown
        m.lathe([(R * 0.95, ty + 0.012, -0.03), (R * 0.9, ty + 0.05, -0.035), (R * 0.68, ty + 0.1, -0.04), (R * 0.3, ty + 0.13, -0.045)], P["acc"], n=16, c=tuple(hc), cap0=True, cap1=(hc.x, hc.y + ty + 0.14, hc.z - 0.045))
    elif s == 1:
        # a tall cone hat with a rounded tip
        m.lathe([(R * 0.98, ty + 0.01, -0.03), (R * 0.92, ty + 0.04, -0.03), (R * 0.55, ty + 0.17, -0.045), (R * 0.22, ty + 0.29, -0.06)], P["acc"], n=16, c=tuple(hc), cap0=True)
        m.ball((hc.x, hc.y + ty + 0.3, hc.z - 0.062), R * 0.2, R * 0.2, R * 0.2, P["acc"], 8, 4)
    elif s == 2:
        # a wide flat round hat
        b = ty + 0.035
        m.lathe([(R * 0.6, b + 0.07, -0.01), (R * 0.8, b + 0.05, -0.01), (R * 2.1, b - 0.005, -0.01), (R * 2.2, b - 0.02, -0.01), (R * 0.9, b + 0.0, -0.01)], STRAW, n=20, c=tuple(hc), cap0=(hc.x, hc.y + b + 0.075, hc.z - 0.01))
    elif s == 3 and not miner:
        # a round-edged fez
        m.lathe([(R * 0.88, ty + 0.0, -0.035), (R * 0.9, ty + 0.06, -0.035), (R * 0.88, ty + 0.15, -0.04), (R * 0.78, ty + 0.19, -0.04), (R * 0.4, ty + 0.205, -0.04)], P["acc"], n=16, c=tuple(hc), cap0=True, cap1=(hc.x, hc.y + ty + 0.21, hc.z - 0.04))
    elif miner:
        m.lathe([(R * 1.06, ty - 0.04, -0.01), (R * 1.04, ty + 0.0, -0.015), (R * 0.85, ty + 0.08, -0.02), (R * 0.4, ty + 0.13, -0.025)], DARK, n=16, c=tuple(hc), cap1=(hc.x, hc.y + ty + 0.14, hc.z - 0.025))
        brow_lamp(m, Head(hc, R + 0.015, drop=0.12, half=0.9 + 0.12))
    if s == 2 and not miner:
        cane(m, hands[1])
    if miner:
        carry(m, s, miner, hands, P)
    return m


VARIANTS = {1: ("Kin", v1), 2: ("Big round heads", v2), 3: ("Hooded mantles", v3), 4: ("Masks", v4), 5: ("Soft geometry", v5)}
LINEUP = [("s0", 0, False, False), ("s1", 1, False, False), ("s2", 2, False, False), ("s3", 3, False, False), ("child", 0, True, False), ("miner", 3, False, True)]


# ------------------------------------------------------------------ Blender scene


def flat_material():
    """Flat game-like shading: albedo (vertex colour) times a soft two-tone light (warm key, cool sky fill)."""
    mat = bpy.data.materials.new("flat")
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "col"
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
    dif.inputs["Color"].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = 0.04
    mr.inputs["From Max"].default_value = 0.42
    mixn = nt.nodes.new("ShaderNodeMix")
    mixn.data_type = "RGBA"
    mixn.inputs["A"].default_value = (*srgb_to_lin((0.6, 0.66, 0.74)), 1)
    mixn.inputs["B"].default_value = (*srgb_to_lin((1.04, 1.0, 0.92)), 1)
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    em = nt.nodes.new("ShaderNodeEmission")
    L = nt.links
    L.new(dif.outputs[0], s2r.inputs[0])
    L.new(s2r.outputs["Color"], bw.inputs[0])
    L.new(bw.outputs[0], mr.inputs["Value"])
    L.new(mr.outputs["Result"], mixn.inputs["Factor"])
    L.new(attr.outputs["Color"], mul.inputs["A"])
    L.new(mixn.outputs["Result"], mul.inputs["B"])
    L.new(mul.outputs["Result"], em.inputs["Color"])
    L.new(em.outputs[0], out.inputs["Surface"])
    return mat


def to_object(name, m, mat, linear=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([gb(p) for p in m.v], [], m.f)
    me.validate(clean_customdata=False)
    a = me.attributes.new("col", "FLOAT_COLOR", "POINT")
    cols = [c if linear else srgb_to_lin(c) for c in m.c]
    a.data.foreach_set("color", [x for c in cols for x in (*c, 1.0)])
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def paint(ob, rgb):
    me = ob.data
    a = me.attributes.new("col", "FLOAT_COLOR", "POINT")
    c = srgb_to_lin(rgb)
    a.data.foreach_set("color", [x for _ in range(len(me.vertices)) for x in (*c, 1.0)])


def wanderer(mat):
    """The hero, assembled standing from wanderer.glb as figure.ts does, his hood sphere and disc face added."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=WANDERER_GLB)
    parts = {o.name.split(".")[0]: o for o in set(bpy.data.objects) - before if o.type == "MESH"}
    root = bpy.data.objects.new("wanderer", None)
    bpy.context.scene.collection.objects.link(root)
    DRESS, CLOAK = (0.11, 0.1, 0.095), (0.2, 0.18, 0.16)
    HIP, THIGH = 0.78, 0.39
    for n, o in parts.items():
        o.data.materials.clear()
        o.data.materials.append(mat)
        paint(o, DRESS if n in ("Dress", "LegUpper", "LegLower", "Shoe", "ArmLimb", "Hand") else CLOAK)
        for p in o.data.polygons:
            p.use_smooth = True
        o.parent = root

    def place(o, loc, rot=None):
        mm = Matrix.Translation(Vector(gb(loc)))
        if rot is not None:
            mm = mm @ rot
        o.matrix_world = mm

    for sx in (-1, 1):
        for name, loc in (("LegUpper", (sx * 0.065, HIP, 0)), ("LegLower", (sx * 0.065, HIP - THIGH, 0)), ("Shoe", (sx * 0.065, HIP - THIGH, 0))):
            o = parts[name].copy()
            bpy.context.scene.collection.objects.link(o)
            place(o, loc)
            o.parent = root
        sh = Vector((sx * 0.09, 1.3, 0))
        tgt = Vector((sx * 0.17, 0.87, 0.03))
        d = tgt - sh
        ln = d.length
        q = Vector(gb((0, -1, 0))).rotation_difference(Vector(gb(d / ln))).to_matrix().to_4x4()
        a = parts["ArmLimb"].copy()
        bpy.context.scene.collection.objects.link(a)
        a.matrix_world = Matrix.Translation(Vector(gb(sh))) @ q @ Matrix.Diagonal((1, 1, ln, 1))
        a.parent = root
        hnd = parts["Hand"].copy()
        bpy.context.scene.collection.objects.link(hnd)
        hnd.matrix_world = Matrix.Translation(Vector(gb(sh + d))) @ q
        hnd.parent = root
    for n in ("LegUpper", "LegLower", "Shoe", "ArmLimb", "Hand"):
        bpy.data.objects.remove(parts[n])
    # hood sphere, head and the face as the hood shader draws it (white inside the face cone)
    HOOD_Y, HOOD_Z, HOOD_R, HEAD_R = 1.56, -0.03, 0.155, 0.125
    C = Vector((0, HOOD_Y, HOOD_Z))
    HEAD_O = Vector((0, 1.55 - HOOD_Y, 0.035 - HOOD_Z))
    h = Head(C, HOOD_R, drop=0.11, half=math.acos(0.6))

    def surf(dirn):
        th = HOOD_R / Vector((dirn.x, dirn.y / 1.03, dirn.z)).length
        b = dirn.dot(HEAD_O)
        disc = b * b - (HEAD_O.length_squared - HEAD_R * HEAD_R)
        return max(th, b + math.sqrt(max(disc, 0.0)))

    m = Mesh()
    h.ball(m, CLOAK, 32, 20, ys=1.03)
    m.ball(tuple(C + HEAD_O), HEAD_R, HEAD_R, HEAD_R, CLOAK, 24, 14)
    h.face(m, rows=8, n=48, lift=0.003, dist=surf, flat=0.0)
    ob = to_object("wanderer_head", m, mat)
    ob.parent = root
    return root


def scene_setup(label):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE"
    except TypeError:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    sc.render.resolution_x, sc.render.resolution_y = 1600, 700
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = "Standard"
    try:
        sc.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    world = bpy.data.worlds.new("w")
    sc.world = world
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    sky = nt.nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (*srgb_to_lin((0.72, 0.86, 0.84)), 1)
    dark = nt.nodes.new("ShaderNodeBackground")
    dark.inputs["Color"].default_value = (0, 0, 0, 1)
    lp = nt.nodes.new("ShaderNodeLightPath")
    mx = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mx.inputs["Fac"])
    nt.links.new(dark.outputs[0], mx.inputs[1])
    nt.links.new(sky.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs["Surface"])

    mat = flat_material()
    g = Mesh()
    S = 30
    g.sheet([[(-S, 0, -S), (S, 0, -S)], [(-S, 0, S), (S, 0, S)]], (0.92, 0.8, 0.62), [(0, -1, -S), (0, -1, S)], closed=False)
    to_object("ground", g, mat)

    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 1.0
    sun.angle = math.radians(3)
    so = bpy.data.objects.new("sun", sun)
    sc.collection.objects.link(so)
    # low late-afternoon sun from the camera's left, in front
    so.rotation_euler = (math.radians(50), 0, math.radians(-40))

    cam = bpy.data.cameras.new("cam")
    cam.lens = 50
    cam.sensor_fit = "HORIZONTAL"
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    eye = Vector(gb((0.0, 2.55, 10.6)))
    tgt = Vector(gb((0.0, 0.98, 0.0)))
    co.location = eye
    co.rotation_euler = (tgt - eye).to_track_quat("-Z", "Y").to_euler()

    txt = bpy.data.curves.new("label", "FONT")
    txt.body = label
    txt.size = 0.022
    to = bpy.data.objects.new("label", txt)
    sc.collection.objects.link(to)
    tm = bpy.data.materials.new("ink")
    nt2 = tm.node_tree
    for n in list(nt2.nodes):
        nt2.nodes.remove(n)
    e = nt2.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (*srgb_to_lin((0.16, 0.2, 0.22)), 1)
    o2 = nt2.nodes.new("ShaderNodeOutputMaterial")
    nt2.links.new(e.outputs[0], o2.inputs["Surface"])
    txt.materials.append(tm)
    to.parent = co
    to.location = (-0.345, 0.128, -1.0)
    to.visible_shadow = False
    return mat


def build_variant(n, out_dir):
    name, fn = VARIANTS[n]
    mat = scene_setup(f"{n}  {name}")
    sc = bpy.context.scene
    figs = []
    w = wanderer(mat)
    figs.append(w)
    counts = {}
    for who, s, kid, miner in LINEUP:
        m = fn(s, kid, miner)
        counts[who] = m.tris() - m.props if not m.props else f"{m.tris() - m.props} + {m.props} pick/lamp"
        ob = to_object(f"{who}", m, mat)
        if kid:
            ob.scale = (0.6, 0.6, 0.6)
        figs.append(ob)
    print(f"FOLK variant {n} {name}: triangles per person {counts}")
    xs = [-3.05, -2.0, -1.0, 0.0, 1.0, 1.9, 2.85]
    yaw = math.radians(-32)
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for view, extra in (("front", 0.0), ("back", math.pi)):
        for ob, x in zip(figs, xs):
            ob.location = (x, 0, 0)
            ob.rotation_euler = (0, 0, yaw + extra)
        sc.render.filepath = os.path.join(out_dir, f"v{n}_{view}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(sc.render.filepath)
        print("FOLK wrote", sc.render.filepath)
    return counts


def contact_sheet(out_dir):
    import numpy as np

    imgs = []
    for n in sorted(VARIANTS):
        im = bpy.data.images.load(os.path.join(out_dir, f"v{n}_front.png"))
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        imgs.append(a)
    gap = np.ones((8, imgs[0].shape[1], 4), dtype=np.float32)
    gap[..., :3] = 0.95
    stack = []
    for a in reversed(imgs):  # Blender images run bottom-up
        stack += [a, gap]
    full = np.concatenate(stack[:-1], axis=0)
    H, W = full.shape[:2]
    out = bpy.data.images.new("all", W, H, alpha=True)
    out.pixels.foreach_set(full.ravel())
    out.filepath_raw = os.path.join(out_dir, "all.png")
    out.file_format = "PNG"
    out.save()
    print("FOLK wrote", out.filepath_raw)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = argv[argv.index("--out") + 1] if "--out" in argv else os.path.join(HERE, "renders")
    if "--sheet" in argv:
        contact_sheet(argv[argv.index("--sheet") + 1])
        return
    v = argv[argv.index("--variant") + 1] if "--variant" in argv else "all"
    ns = sorted(VARIANTS) if v == "all" else [int(v)]
    for n in ns:
        build_variant(n, out)


if __name__ == "__main__":
    main()
