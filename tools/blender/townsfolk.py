"""The townsfolk and miners ("Kin": every person wears the wanderer's own head, a pleated dress and
an open cloak), one mesh holding every silhouette of src/city/people.ts, exported to
public/art/townsfolk.glb.

    blender --background --python tools/blender/townsfolk.py                    # write the .glb
    blender --background --python tools/blender/townsfolk.py -- --preview DIR   # and render it

The design is direction 1 of tools/blender/folk_variants/build.py (v1), rebuilt here with every
vertex tagged for the crowd's shader. Everything is built in the game's own frame (metres, +Y up,
feet at 0, facing +Z) and turned into Blender's Z-up frame only when the mesh is made, so the
exporter's +Y-up conversion gives back exactly these numbers. Each vertex carries:

  _apart (aPart)  x: 0 robe (dress, cloak, arms), 1 head and hood (turns with the head), 2/3 legs,
                  4 the elder's staff;  y: shade multiplier
  _akind (aKind)  x: material: 0 dress cloth, 1 white face, 2 dark, 3 cloak, 4 light trim,
                  5 leather / wood, 6 lamp glass;
                  y: silhouette (0..3, -1 all, -2 all but 1, 4 the miner only, 5 silhouette 3
                  but not the miner);  z: robe height 0 hem .. 1 neck, or -1 for a vertex placed as is

A vertex with aKind.z >= 0 is robe-relative: the shader puts it at height robe(z).y and multiplies
its x and z by the silhouette's dress radius there (robe() in people.ts, mirrored below), so the
one shared dress takes every silhouette's width and the elder's bent back. Everything else is in
metres; the elder's own parts are bent here with the same bend. The silhouettes differ by cloak cut
and one accessory: 0 knee cloak and a sash, 1 ankle cloak and a stole, 2 the bent elder in a short
cape with a tall staff, 3 mid-length cloak and a turban over the hood; the miner (silhouette 3's
body) a leather cloak and hood with a lamp on the brow. Winding is counter-clockwise seen from
outside (the material culls back faces), so the open cloak is built with an inner side too.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "public", "art", "townsfolk.glb"))
SHAPES = 4
MINER = 4  # the miner's own draw (silhouette 3's body), as people.ts shapeFigure builds it

# materials (aKind.x)
CLOTH, FACE, DARK_M, CLOAK, TRIM, LEATHER_M, GLASS = 0, 1, 2, 3, 4, 5, 6

# ---------------------------------------------------------------- the shader's robe, mirrored


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


WIDE = {0: 1.1, 1: 0.86, 2: 1.0, 3: 0.92}
NECK = 1.42


def hem0(s):
    return 0.365 if s == 2 else 0.325


def bend(p):
    """The elder's bent back: nothing below the waist, the shoulders forward and down, the neck
    down 0.2 and forward 0.14 (where the shader puts the elder's head)."""
    t = min(1.0, max(0.0, (p[1] - 0.72) / 0.7))
    return (p[0], p[1] - 0.2 * t * t, p[2] + 0.14 * t * t)


def robe(v, s):
    """people.ts robe(): radius, height, forward offset of the dress at height v for silhouette s."""
    y = mix(hem0(s), NECK, v)
    r = (0.07 + 0.24 * max(0.0, (NECK - y) / 1.06) ** 1.45) * WIDE[s]
    if s == 2:
        _, yb, oz = bend((0, y, 0))
        return r, yb, oz
    return r, y, 0.0


def robe_v(y):
    return (y - 0.325) / (NECK - 0.325)


# ---------------------------------------------------------------- mesh building


class Mesh:
    """Vertices with the shader's tags. `real` holds where each vertex is in metres (for winding);
    `pos` what is exported (robe multipliers for robe-relative vertices)."""

    def __init__(self):
        self.pos, self.real, self.part, self.kind, self.tri = [], [], [], [], []
        self.pid, self.mat, self.who, self.shade = 0, CLOTH, -1, 1.0

    def set(self, pid=None, mat=None, who=None, shade=None):
        if pid is not None:
            self.pid = pid
        if mat is not None:
            self.mat = mat
        if who is not None:
            self.who = who
        if shade is not None:
            self.shade = shade

    def vert(self, p, v=-1.0, real=None, shade=None):
        self.pos.append(tuple(p))
        self.real.append(Vector(real if real is not None else p))
        self.part.append((self.pid, self.shade if shade is None else shade))
        self.kind.append((self.mat, self.who, v))
        return len(self.pos) - 1

    def face(self, idx, inside, flip=False):
        """A polygon (fanned into triangles), wound so its normal points away from `inside`."""
        pts = [self.real[i] for i in idx]
        n = Vector()
        for a, b in zip(pts, pts[1:] + pts[:1]):
            n += a.cross(b)
        cen = sum(pts, Vector()) / len(pts)
        if (n.dot(cen - Vector(inside)) < 0) != flip:
            idx = idx[::-1]
        for k in range(1, len(idx) - 1):
            self.tri.append((idx[0], idx[k], idx[k + 1]))

    def sheet(self, rows, inside, closed=True, cap0=None, cap1=None, shade=None, flip=False):
        sf = shade or (lambda i, j, p: None)
        ids = [[self.vert(p, shade=sf(i, j, Vector(p))) for j, p in enumerate(row)] for i, row in enumerate(rows)]
        n = len(rows[0])
        m = n if closed else n - 1
        for i in range(len(rows) - 1):
            ins = (Vector(inside[i]) + Vector(inside[i + 1])) / 2
            for j in range(m):
                j1 = (j + 1) % n
                self.face([ids[i][j], ids[i][j1], ids[i + 1][j1], ids[i + 1][j]], ins, flip)
        for cap, row, other in ((cap0, 0, 1), (cap1, -1, -2)):
            if cap is None:
                continue
            ref = (Vector(inside[row]) + Vector(inside[other])) / 2 if len(rows) > 1 else Vector(inside[row])
            c = self.vert(cap, shade=sf(0 if row == 0 else len(rows) - 1, 0, Vector(cap)))
            for j in range(m):
                self.face([c, ids[row][j], ids[row][(j + 1) % n]], ref, flip)
        return ids

    def lathe(self, prof, n=16, c=(0, 0, 0), zs=1.0, arc=None, cap0=None, cap1=None, wob=None, yof=None, shade=None, flip=False):
        """Revolve (r, y[, dz]) round the vertical through c; arc: only the back, out to this half-angle."""
        rows, ins = [], []
        cnt = n if arc is None else n + 1
        for i, pr in enumerate(prof):
            r, y = pr[0], pr[1]
            dz = pr[2] if len(pr) > 2 else 0.0
            row = []
            for j in range(cnt):
                a = j / n * TAU if arc is None else math.pi - arc + 2 * arc * j / n
                rr = r * (wob(a, i) if wob else 1.0)
                yy = y + (yof(a, i) if yof else 0.0)
                row.append((c[0] + math.sin(a) * rr, c[1] + yy, c[2] + dz + math.cos(a) * rr * zs))
            rows.append(row)
            ins.append((c[0], c[1] + y, c[2] + dz))
        return self.sheet(rows, ins, closed=arc is None, cap0=cap0, cap1=cap1, shade=shade, flip=flip)

    def ball(self, c, rx, ry, rz, n=8, rows=4):
        rs = []
        for j in range(1, rows + 1):
            a = j / (rows + 1) * math.pi
            rs.append([(c[0] + math.sin(k / n * TAU) * math.sin(a) * rx, c[1] - math.cos(a) * ry, c[2] + math.cos(k / n * TAU) * math.sin(a) * rz) for k in range(n)])
        self.sheet(rs, [c] * rows, cap0=(c[0], c[1] - ry, c[2]), cap1=(c[0], c[1] + ry, c[2]))

    def tube(self, path, radii, n=6, caps=True, flat=1.0, side=None):
        path = [Vector(p) for p in path]
        rows = []
        L = len(path)
        for i, p in enumerate(path):
            t = (path[min(L - 1, i + 1)] - path[max(0, i - 1)]).normalized()
            ref = Vector(side) if side else (Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0)))
            z = (ref - t * ref.dot(t)).normalized()
            x = t.cross(z)
            r = radii[i]
            rows.append([tuple(p + x * (math.sin(k / n * TAU) * r) + z * (math.cos(k / n * TAU) * r * flat)) for k in range(n)])
        self.sheet(rows, [tuple(p) for p in path], cap0=tuple(path[0]) if caps else None, cap1=tuple(path[-1]) if caps else None)

    def deform(self, fn, start):
        for i in range(start, len(self.pos)):
            self.pos[i] = tuple(fn(self.pos[i]))
            self.real[i] = Vector(self.pos[i])


# ---------------------------------------------------------------- the wanderer's head


class Head:
    """A round hood centred at c, radius R, its face looking along `ax` (tipped a little down);
    theta is the angle from the face axis, phi round it (0 = +x, pi/2 = up)."""

    def __init__(self, c, R, drop=0.11, half=math.acos(0.6), ys=1.03):
        self.c = Vector(c)
        self.R = R
        self.ys = ys
        self.ax = Vector((0, -drop, 1)).normalized()
        self.e1 = Vector((1, 0, 0))
        self.e2 = self.ax.cross(self.e1).normalized()
        if self.e2.y < 0:
            self.e2 = -self.e2
        self.half = half

    def d(self, theta, phi):
        return (self.ax * math.cos(theta) + (self.e1 * math.cos(phi) + self.e2 * math.sin(phi)) * math.sin(theta)).normalized()

    def surf(self, dd):
        """The hood ellipsoid's radius along the direction dd."""
        return self.R / Vector((dd.x, dd.y / self.ys, dd.z)).length


HEAD_C = (0.0, 1.56, -0.03)
HEAD_R = 0.155


def hood(m, mat, shade=1.0, turban=False, brow_lamp=False):
    """The wanderer's hood: a sphere, a soft rolled rim round the face, the point lifting behind
    the crown and hanging down the back; optionally a turban over it or a lamp on the brow."""
    h = Head(HEAD_C, HEAD_R)
    m.set(pid=1, mat=mat, shade=shade)
    m.ball(HEAD_C, HEAD_R, HEAD_R * h.ys, HEAD_R, 12, 6)
    m.set(shade=shade * 0.9)
    # the rim: a roll round the face opening, thicker over the brow
    n, sides = 16, 3
    theta, dist = h.half + 0.11, HEAD_R + 0.014
    P = [h.c + h.d(theta, j / n * TAU) * dist for j in range(n)]
    rad = [0.017 * (0.75 + 0.45 * max(0.0, math.sin(j / n * TAU))) for j in range(n)]
    ids = []
    for j in range(n):
        t = (P[(j + 1) % n] - P[(j - 1) % n]).normalized()
        out = (P[j] - h.c).normalized()
        b = t.cross(out).normalized()
        ids.append([m.vert(tuple(P[j] + out * math.cos(k / sides * TAU) * rad[j] + b * math.sin(k / sides * TAU) * rad[j])) for k in range(sides)])
    for j in range(n):
        j1 = (j + 1) % n
        for k in range(sides):
            k1 = (k + 1) % sides
            m.face([ids[j][k], ids[j][k1], ids[j1][k1], ids[j1][k]], (P[j] + P[j1]) / 2)
    m.set(shade=shade)
    ctrl = [(0, 0.06, -0.07), (0, 0.105, -0.125), (0, 0.06, -0.168), (0, -0.02, -0.168), (0, -0.1, -0.15)]
    m.tube([tuple(h.c + Vector(p)) for p in ctrl], [0.075, 0.055, 0.042, 0.03, 0.004], 7, flat=0.7, side=(1, 0, 0))
    if turban:
        m.set(mat=CLOAK, shade=1.0)
        rows = [(0.118, 0.105), (0.15, 0.13), (0.158, 0.165), (0.145, 0.205), (0.1, 0.235)]
        c = HEAD_C
        m.lathe([(r, y, -0.045) for r, y in rows], 12, c=c, cap0=(c[0], c[1] + 0.105, c[2] - 0.045), cap1=(c[0], c[1] + 0.245, c[2] - 0.045),
                wob=lambda a, i: 1 + 0.07 * math.cos(2 * a + 1.7 * i))
    if brow_lamp:
        d = h.d(h.half + 0.32, math.pi / 2)
        p = h.c + d * (h.R + 0.03)
        m.set(mat=DARK_M, shade=1.0)
        m.lathe([(0.035, -0.03), (0.04, 0.0), (0.035, 0.035)], 8, c=tuple(p), cap0=tuple(p + Vector((0, -0.03, 0))))
        m.set(mat=GLASS)
        m.ball(tuple(p + Vector((0, 0.0, 0.035))), 0.03, 0.03, 0.012, 8, 2)
    return h


def face_disc(m):
    """The clean white disc: its own slightly domed cap a centimetre in front of the hood, out to
    the half-angle; the hood's rim covers its edge. One for everyone."""
    h = Head(HEAD_C, HEAD_R)
    m.set(pid=1, mat=FACE, who=-1, shade=1.0)
    rows, n, lift = 3, 16, 0.009
    rs = []
    for k in range(1, rows + 1):
        th = h.half * k / rows
        rs.append([tuple(h.c + h.d(th, j / n * TAU) * (h.surf(h.d(th, j / n * TAU)) + lift)) for j in range(n)])
    pole = h.c + h.ax * (h.surf(h.ax) + lift)
    m.sheet(rs, [tuple(h.c)] * rows, cap0=tuple(pole))


# ---------------------------------------------------------------- the figure

DRESS_Y = [0.36, 0.5, 0.72, 0.95, 1.16, 1.32, 1.42]
N_DRESS = 18
SCALLOP = 0.032  # the hem's scallop, in robe height


def dress(m):
    """The pleated, scalloped dress, robe-relative: shared by every silhouette."""
    m.set(pid=0, mat=CLOTH, who=-1, shade=1.0)
    ids = []
    for i, y in enumerate(DRESS_Y):
        row = []
        for j in range(N_DRESS):
            a = j / N_DRESS * TAU
            wob = 1 + 0.1 * math.cos(6 * a) * max(0.0, 1 - i / 4)
            v = robe_v(y) - (SCALLOP * (0.5 + 0.5 * math.sin(7 * a)) if i == 0 else 0.0)
            mx, mz = wob, wob * 0.88 / 0.86
            r, yy, oz = robe(v, 0)
            real = (math.sin(a) * mx * r, yy, math.cos(a) * mz * r * 0.86 + oz)
            row.append(m.vert((math.sin(a) * mx, NECK * v, math.cos(a) * mz), v, real))
        ids.append(row)
    for i in range(len(ids) - 1):
        ins = (0, robe(robe_v(DRESS_Y[i]), 0)[1], 0)
        for j in range(N_DRESS):
            j1 = (j + 1) % N_DRESS
            m.face([ids[i][j], ids[i][j1], ids[i + 1][j1], ids[i + 1][j]], ins)
    v = 0.06
    c = m.vert((0, NECK * v, 0), v, (0, robe(v, 0)[1], 0), shade=0.6)
    for j in range(N_DRESS):
        m.face([c, ids[0][j], ids[0][(j + 1) % N_DRESS]], (0, 1.0, 0))


def legs(m):
    """Thin dark legs and small shoes, the tops hidden up inside the dress."""
    for pid, sx in ((2, 0.068), (3, -0.068)):
        m.set(pid=pid, mat=DARK_M, who=-1, shade=1.0)
        m.tube([(sx, 0.05, 0.0), (sx, 0.45, -0.005)], [0.024, 0.03], 5, caps=False)
        m.ball((sx, 0.03, 0.03), 0.034, 0.032, 0.064, 6, 2)


CUT = {0: (0.74, 0.34, 2.2), 1: (0.2, 0.34, 2.5), 2: (1.0, 0.3, 2.6), 3: (0.56, 0.27, 2.1)}


def cloak(m, s, who, mat):
    """The open cloak, back and sides only, cut per silhouette; an inner side so it reads from the front."""
    chem, cr, carc = CUT[s]
    cy = [chem, mix(chem, 1.45, 0.4), mix(chem, 1.45, 0.75), 1.38, 1.45]
    cp = [(mix(cr, 0.105, smoothstep(chem, 1.45, y) ** 0.8) * (1.18 if y == 1.38 else 1.0), y, -0.01) for y in cy]
    yof = lambda a, i: -0.03 * (0.5 + 0.5 * math.sin(9 * a)) if i == 0 else 0.0  # noqa: E731
    m.set(pid=0, mat=mat, who=who)
    start = len(m.pos)
    m.lathe(cp, 10, zs=0.92, arc=carc, yof=yof, shade=lambda i, j, p: 0.82 + 0.18 * smoothstep(chem, 1.4, p.y))
    m.lathe([(r * 0.975, y, dz) for r, y, dz in cp], 10, zs=0.92, arc=carc, yof=yof, flip=True,
            shade=lambda i, j, p: 0.72 + 0.12 * smoothstep(chem, 1.4, p.y))
    if s == 2:
        m.deform(bend, start)


HANDS = [(0.2, 0.88, 0.07), (-0.2, 0.88, 0.07)]
ELDER_HAND = (-0.27, 0.97, 0.2)


def arms(m, s, who):
    """Sleeves in the dress colour from the shoulders under the cloak, white mitten hands."""
    start = len(m.pos)
    hands = list(HANDS)
    if s == 2:
        hands[1] = ELDER_HAND
    for sx, hd in zip((1, -1), hands):
        sh, hd = Vector((sx * 0.13, 1.3, 0.0)), Vector(hd)
        d = hd - sh
        mid = sh + d * 0.5 + Vector((math.copysign(0.03, sh.x), 0, -0.01))
        m.set(pid=0, mat=CLOTH, who=who, shade=0.9)
        m.tube([sh, mid, sh + d * 0.86], [0.032, 0.036, 0.042], 6, caps=False)
        m.set(mat=FACE, shade=1.0)
        m.ball(tuple(hd), 0.036, 0.045, 0.036, 6, 2)
    if s == 2:
        m.deform(bend, start)
    return bend(hands[1]) if s == 2 else hands[1]


def build():
    m = Mesh()
    dress(m)
    legs(m)
    face_disc(m)

    for s in range(SHAPES):
        who = 5 if s == 3 else s
        arm_who = s  # silhouette 3's arms are the miner's too
        hand = arms(m, s, arm_who)
        cloak(m, s, who, CLOAK)
        # the hood (keeps the cloak's `who`): in the cloak's colour, silhouette 3's in the dress
        # colour under a turban
        hood(m, CLOTH if s == 3 else CLOAK, turban=s == 3)
        if s == 0:
            # a sash round the waist, its end hanging at the front
            m.set(pid=0, mat=TRIM, shade=1.0)
            r = robe(robe_v(0.98), 0)[0] * 1.1
            m.lathe([(r, 0.95), (r * 1.04, 0.98), (r, 1.01)], 12, zs=0.88)
            m.tube([(0.07, 0.96, r * 0.9), (0.09, 0.84, r * 1.0), (0.1, 0.72, r * 1.1)], [0.028, 0.03, 0.02], 4, flat=0.4)
        elif s == 1:
            # a stole over the shoulders, both ends down the front
            m.set(pid=0, mat=TRIM, shade=1.0)
            for sx in (1, -1):
                m.tube([(sx * 0.1, 1.42, -0.04), (sx * 0.1, 1.38, 0.07), (sx * 0.1, 1.15, 0.11), (sx * 0.1, 0.85, 0.15)], [0.034, 0.036, 0.036, 0.034], 4, flat=0.35, side=(0, 0, 1))
        elif s == 2:
            # the tall staff in the right hand, a strip of cloth tied below its top
            hx, hy, hz = hand
            h = 1.75
            m.set(pid=4, mat=LEATHER_M, shade=1.12)
            m.tube([(hx, 0.0, hz), (hx, hy, hz), (hx, h, hz - 0.02)], [0.014, 0.015, 0.013], 6)
            m.set(mat=TRIM, shade=1.0)
            m.tube([(hx, h - 0.08, hz - 0.02), (hx + 0.02, h - 0.2, hz - 0.06), (hx + 0.01, h - 0.34, hz - 0.08)], [0.02, 0.028, 0.01], 5)

    # the miner: silhouette 3's dress and arms, a leather cloak and hood, a lamp on the brow
    cloak(m, 3, MINER, LEATHER_M)
    hood(m, LEATHER_M, brow_lamp=True)  # keeps the cloak's `who`
    return m


# ---------------------------------------------------------------- per-draw selection (people.ts shapeFigure)


def mask(who):
    allb = (1 << (SHAPES + 1)) - 1
    if who < -1.5:
        return allb & ~2
    if who < -0.5:
        return allb
    if who > 4.5:
        return 1 << 3
    if who > 3.5:
        return 1 << MINER
    s = int(round(who))
    return (1 << s) | ((1 << MINER) if s == 3 else 0)


def draw_tris(m, t):
    vm = [mask(k[1]) for k in m.kind]
    return [tr for tr in m.tri if (vm[tr[0]] | vm[tr[1]] | vm[tr[2]]) & (1 << t)]


def counts(m):
    return {("miner" if t == MINER else t): len(draw_tris(m, t)) for t in range(SHAPES + 1)}


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


def export(m):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ob = make_mesh("townsfolk", m.pos, m.tri)
    me = ob.data
    ap = me.attributes.new("_apart", "FLOAT2", "POINT")
    ak = me.attributes.new("_akind", "FLOAT_VECTOR", "POINT")
    ap.data.foreach_set("vector", [c for t in m.part for c in t])
    ak.data.foreach_set("vector", [c for t in m.kind for c in t])
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


# ---------------------------------------------------------------- previews: the shader's rules


def srgb_to_lin(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


FIG_DARK = (0.2, 0.17, 0.16)
LEATHER = (0.45, 0.29, 0.17)
LINEN = (0.9, 0.86, 0.76)


def tint(mk, v, iC, iE, mode):
    """people.ts figureFrag's albedo for one vertex (before light)."""
    own = abs(mode - 0.25) < 0.12
    if mk == FACE:
        return (0.97, 0.95, 0.9)
    if mk == DARK_M:
        return FIG_DARK
    if mk == GLASS:
        return (1.0, 0.84, 0.5)
    if mk >= CLOAK:
        cl = iE if own else tuple(iE[k] * f for k, f in enumerate((0.55, 0.5, 0.6)))
        if mk == CLOAK:
            return cl
        if mk == TRIM:
            return tuple(mix(cl[k], LINEN[k], 0.6) for k in range(3))
        return LEATHER
    h = 1.0 if v < 0 else v
    if own:
        return iC
    if mode > 0.375:
        return iC  # the crisp hem is drawn per pixel (posed() hands it to the material as `hb`)
    t = smoothstep(0.15, 0.85, h)
    return tuple(mix(iE[k], iC[k], t) for k in range(3))


def posed(m, t, iC, iE, mode, sit=0.0, yaw=0.0):
    """The pose the vertex shader gives a person of draw t: robe shaped, the elder's head lowered,
    the head turned by `yaw`, sitting; and each vertex's colour."""
    shape = 3 if t == MINER else t
    pos, col, hb = [], [], []
    for i, p in enumerate(m.pos):
        mk, who, v = m.kind[i]
        pid, shade = m.part[i]
        if v >= 0:
            r, y, oz = robe(v, shape)
            p = (p[0] * r, y, p[2] * r * 0.86 + oz)
        if pid == 1:
            q = (p[0], p[1] - 1.42, p[2])
            pitch = sit * 0.05
            cp, sp = math.cos(pitch), math.sin(pitch)
            q = (q[0], cp * q[1] - sp * q[2], sp * q[1] + cp * q[2])
            cy, sy = math.cos(yaw), math.sin(yaw)
            q = (cy * q[0] + sy * q[2], q[1], -sy * q[0] + cy * q[2])
            p = (q[0], q[1] + 1.42, q[2])
            if shape == 2:
                p = (p[0], p[1] - 0.2, p[2] + 0.14)
        if sit > 0.001:
            if p[1] < 0.6:
                s_ = (p[0], p[1] * 0.28, p[2] + (0.6 - p[1]) * 0.75)
            else:
                ry, lb = p[1] - 0.6, -0.12
                s_ = (p[0], 0.168 + ry * math.cos(lb) - p[2] * math.sin(lb), ry * math.sin(lb) + p[2] * math.cos(lb))
            p = tuple(mix(p[k], s_[k], sit) for k in range(3))
        pos.append(p)
        c = tint(mk, v, iC, iE, mode)
        col.append(tuple(x * (shade if mk not in (FACE, DARK_M, GLASS) else 1.0) for x in c))
        hb.append(v if (mk == CLOTH and mode > 0.375 and v >= 0) else 9.0)
    keep = [tr for tr in draw_tris(m, t) if not (sit > 0.3 and any(m.part[k][0] > 3.5 for k in tr))]
    return pos, col, keep, hb, iE


# trade-city clothes like the v1 renders: (draw, iC, iE, iE.w fraction, height scale)
LINEUP = [
    ("s0", 0, (0.7, 0.5, 0.26), (0.6, 0.3, 0.2), 0.25, 1.0),
    ("s1", 1, (0.96, 0.28, 0.5), (0.98, 0.62, 0.2), 0.0, 1.0),
    ("s2", 2, (0.84, 0.78, 0.66), (0.22, 0.44, 0.44), 0.25, 1.0),
    ("s3", 3, (0.26, 0.3, 0.5), (0.7, 0.5, 0.26), 0.25, 1.0),
    ("child", 0, (0.98, 0.8, 0.22), (0.94, 0.3, 0.46), 0.0, 0.6),
    ("miner", MINER, (1.0, 0.32, 0.0), (1.0, 0.9, 0.05), 0.5, 1.0),
]


def flat_material():
    """Flat game-like shading: albedo (vertex colour) times a soft two-tone light (as folk_variants)."""
    mat = bpy.data.materials.new("flat")
    mat.use_backface_culling = True  # as the game draws them
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "col"
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
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
    # the banded robe's crisp hem, per pixel as the game's fragment shader does it:
    # hem colour where hb <= 0.22, except a stripe of the robe colour between 0.1 and 0.14
    hb = nt.nodes.new("ShaderNodeAttribute")
    hb.attribute_name = "hb"
    col2 = nt.nodes.new("ShaderNodeAttribute")
    col2.attribute_name = "col2"

    def op(o, a, b):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = o
        for k, x in enumerate((a, b)):
            if isinstance(x, float):
                n.inputs[k].default_value = x
            else:
                L.new(x, n.inputs[k])
        return n.outputs[0]

    stripe = op("MULTIPLY", op("GREATER_THAN", hb.outputs["Fac"], 0.1), op("LESS_THAN", hb.outputs["Fac"], 0.14))
    f = op("MULTIPLY", op("LESS_THAN", hb.outputs["Fac"], 0.22), op("SUBTRACT", 1.0, stripe))
    sel = nt.nodes.new("ShaderNodeMix")
    sel.data_type = "RGBA"
    L.new(f, sel.inputs["Factor"])
    L.new(attr.outputs["Color"], sel.inputs["A"])
    L.new(col2.outputs["Color"], sel.inputs["B"])
    L.new(dif.outputs[0], s2r.inputs[0])
    L.new(s2r.outputs["Color"], bw.inputs[0])
    L.new(bw.outputs[0], mr.inputs["Value"])
    L.new(mr.outputs["Result"], mixn.inputs["Factor"])
    L.new(sel.outputs["Result"], mul.inputs["A"])
    L.new(mixn.outputs["Result"], mul.inputs["B"])
    L.new(mul.outputs["Result"], em.inputs["Color"])
    L.new(em.outputs[0], out.inputs["Surface"])
    return mat


def preview(m, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE"
    except TypeError:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    sc.render.resolution_x, sc.render.resolution_y = 1600, 700
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    sc.world = world
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    wout = nt.nodes.new("ShaderNodeOutputWorld")
    sky = nt.nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (*srgb_to_lin((0.72, 0.86, 0.84)), 1)
    dark = nt.nodes.new("ShaderNodeBackground")
    dark.inputs["Color"].default_value = (0, 0, 0, 1)
    lp = nt.nodes.new("ShaderNodeLightPath")
    mx = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mx.inputs["Fac"])
    nt.links.new(dark.outputs[0], mx.inputs[1])
    nt.links.new(sky.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], wout.inputs["Surface"])
    mat = flat_material()

    def colored(name, pos, col, tris, hb=None, hem=(0, 0, 0)):
        ob = make_mesh(name, pos, tris)
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [x for c in col for x in (*srgb_to_lin(c), 1.0)])
        a = ob.data.attributes.new("col2", "FLOAT_COLOR", "POINT")
        a.data.foreach_set("color", [x for _ in col for x in (*srgb_to_lin(hem), 1.0)])
        a = ob.data.attributes.new("hb", "FLOAT", "POINT")
        a.data.foreach_set("value", hb or [9.0] * len(col))
        for p in ob.data.polygons:
            p.use_smooth = True
        ob.data.materials.append(mat)
        return ob

    S = 30
    colored("ground", [(-S, 0, -S), (S, 0, -S), (S, 0, S), (-S, 0, S)], [(0.92, 0.8, 0.62)] * 4, [(0, 3, 2), (0, 2, 1)])
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 1.0
    sun.angle = math.radians(3)
    so = bpy.data.objects.new("sun", sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(-40))
    cam = bpy.data.cameras.new("cam")
    cam.lens = 50
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co

    def look(eye, tgt):
        co.location = Vector(to_blender(eye))
        co.rotation_euler = (Vector(to_blender(tgt)) - Vector(to_blender(eye))).to_track_quat("-Z", "Y").to_euler()

    def shoot(name, sit=0.0, yaw=0.0, turn=math.radians(-32), xs=(-2.5, -1.5, -0.5, 0.5, 1.4, 2.4), items=LINEUP):
        made = []
        for (who, t, iC, iE, mode, hs), x in zip(items, xs):
            pos, col, tris, hb, hem = posed(m, t, iC, iE, mode, sit, yaw)
            ob = colored(who, pos, col, tris, hb, hem)
            ob.scale = (hs, hs, hs)
            ob.location = (x, 0, 0)
            ob.rotation_euler = (0, 0, turn)
            made.append(ob)
        sc.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)
        for ob in made:
            bpy.data.objects.remove(ob)

    look((0.0, 2.55, 10.6), (0.0, 0.98, 0.0))
    shoot("kin_front.png")
    shoot("kin_back.png", turn=math.radians(-32) + math.pi)
    shoot("kin_sitting.png", sit=1.0)
    shoot("kin_headturn.png", yaw=0.9)
    look((0.0, 1.9, 5.2), (0.0, 1.4, 0.0))
    shoot("kin_heads.png", yaw=0.0, turn=0.0, xs=(-1.5, -0.9, -0.3, 0.3, 0.9, 1.5))
    shoot("kin_heads_turned.png", yaw=0.7, turn=0.0, xs=(-1.5, -0.9, -0.3, 0.3, 0.9, 1.5))
    # far away, small, as the crowd is mostly seen
    look((0.0, 6.0, 34.0), (0.0, 0.9, 0.0))
    shoot("kin_far.png")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    m = build()
    export(m)
    print("TOWNSFOLK", OUT, "verts", len(m.pos), "tris", len(m.tri), "per draw", counts(m))
    if "--preview" in argv:
        preview(m, argv[argv.index("--preview") + 1])


main()
