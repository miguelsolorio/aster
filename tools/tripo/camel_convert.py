"""The caravan camel from the Tripo dromedary (tools/tripo/source/camel.glb), into public/art/camel.glb.

    blender --background --python tools/tripo/camel_convert.py                    # write the .glb
    blender --background --python tools/tripo/camel_convert.py -- --preview DIR   # and render it posed

The body is the Tripo mesh, put into the game's frame (metres, +Y up, feet at 0, facing +Z) and
fitted to the rig of tools/blender/camel.py, whose docstring is the contract: the front knees and
the hind hocks are moved onto the joints the shader turns about (hips at (+-0.27, 2.15, +-0.8),
the knee one metre under the hip), the back at the rider's spot (z 0) is brought to CAMEL_BACK
under the pad, and it is cut down to about 1,500 triangles. Its baked texture becomes a colour per
vertex (_acol, scaled so its mean is camel.py's coat colour: caravans.ts tints it by each camel's
coat). The legs are cut from the belly and each carries a closed sleeve up into the body, the way
camel.py's legs are tubes pushed into the trunk, so they swing and fold under it without dragging
the hide. The saddle pad, its fringes and the loads are camel.py's own, laid on this back.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "source", "camel.glb")
CAMEL_PY = os.path.join(ROOT, "tools", "blender", "camel.py")
OUT = os.path.join(ROOT, "public", "art", "camel.glb")

# camel.py's builder, rig helpers, saddle and loads, without running its main()
cp = {"__name__": "camel_py", "__file__": CAMEL_PY}
_src = open(CAMEL_PY).read()
exec(compile(_src[: _src.rindex("\nmain()")], CAMEL_PY, "exec"), cp)
old_trunk_at = cp["trunk_at"]
COAT, DARK, SHADOW, FRINGE, STRAP = cp["COAT"], cp["DARK"], cp["SHADOW"], cp["FRINGE"], cp["STRAP"]
HIP_Y, NECK_PIVOT, LEGS = cp["HIP_Y"], cp["NECK_PIVOT"], cp["LEGS"]
TAIL_ROOT = (0.0, 2.5, -1.3)
COAT_RGB = cp["COAT_RGB"]
smoothstep, mix = cp["smoothstep"], cp["mix"]

# ---------------------------------------------------------------- fitting the Tripo body
# Landmarks of the source, measured in its reference frame (game axes, feet at 0, scaled by
# REF so the hump is 2.85 m): the front knee and the hind hock, centre of the leg at the joint.
REF = 3.516
FRONT_KNEE = (0.97, 0.015)  # (y, z)
HIND_HOCK = (0.9, -1.41)
KNEE_Y = HIP_Y - 1.0  # where the shader turns the lower leg
BACK_TOP = 2.825  # the hide at z 0 on the spine; the pad (4.5 cm, + DRAPE_LIFT) puts the rider at 2.88
WIDTH = 0.95  # a touch narrower than the source, nearer the old camel's footprint
HUE_KEEP = 0.5  # how far the hide's colour is eased toward its mean hue
TARGET_TRIS = 1220  # the decimated hide; the leg sleeves and belly caps bring it to ~1,450
JOINT_SRC = 0.5 * (FRONT_KNEE[0] + HIND_HOCK[0])
Z_MID = 0.5 * (FRONT_KNEE[1] + HIND_HOCK[1])
# The source's trunk is short for the rig: its hocks stand right under the rump, where the
# shader's kneel would throw them far out behind. So the trunk, rump to chest, is drawn out to
# the old camel's length (2.65 m), the neck, head and tail keep their own length, and the legs
# are not stretched but moved, each to stand under its hip.
TRUNK = (-1.62, 0.45)  # source z: the stretch, from behind the rump to the root of the neck
TRUNK_SCALE = 1.35


def fit_z(z):
    c = min(TRUNK[1], max(TRUNK[0], z))
    return (c - Z_MID) * TRUNK_SCALE + (z - c)


def make_fit_y(top_src):
    """Feet to the joints stretched so the knees land on the shader's knee, joints to the back
    pressed a little so the back lands on BACK_TOP; on above at the same rate (neck and head)."""
    lo = KNEE_Y / JOINT_SRC
    hi = (BACK_TOP - KNEE_Y) / (top_src - JOINT_SRC)

    def f(y):
        return y * lo if y < JOINT_SRC else KNEE_Y + (y - JOINT_SRC) * hi

    return f


def load_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC, merge_vertices=True)
    ob = next(o for o in bpy.data.objects if o.type == "MESH")
    me = ob.data
    me.transform(ob.matrix_world)
    ob.matrix_world.identity()
    # Blender (x, y, z up) -> game (x, z, -y), in the reference frame
    g = [(v.co.x * REF, v.co.z * REF, -v.co.y * REF) for v in me.vertices]
    y0 = min(p[1] for p in g)
    g = [(p[0], p[1] - y0 * 1.0, p[2]) for p in g]
    top = max(p[1] for p in g if abs(p[2] - Z_MID) < 0.04 and abs(p[0]) < 0.25)
    fy = make_fit_y(top)
    for v, p in zip(me.vertices, g):
        q = (p[0] * WIDTH, fy(p[1]), p[2])  # z is fitted after the legs are cut
        v.co = (q[0], -q[2], q[1])
    me.update()
    img = None
    for m in me.materials:
        for n in m.node_tree.nodes if m and m.use_nodes else []:
            if n.type == "TEX_IMAGE" and n.image:
                img = n.image
    return ob, img


def decimate(ob):
    tris0 = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    mod = ob.modifiers.new("dec", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = TARGET_TRIS / tris0
    mod.use_symmetry = True
    mod.symmetry_axis = "X"
    tri = ob.modifiers.new("tri", "TRIANGULATE")
    tri.quad_method = "BEAUTY"
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    return me, tris0


def bake_colours(me, img):
    """The texture as a colour per vertex: sampled at each corner's UV and at points inside each
    triangle, averaged over the triangles round a vertex by area, then lightly posterised."""
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uv = me.uv_layers.active.data

    def tex(u, v):
        x = min(w - 1, max(0, int((u % 1.0) * w)))
        y = min(h - 1, max(0, int((v % 1.0) * h)))
        return px[y, x, :3]

    n = len(me.vertices)
    acc = np.zeros((n, 3))
    wt = np.zeros(n)
    bary = [(1 / 3, 1 / 3, 1 / 3), (2 / 3, 1 / 6, 1 / 6), (1 / 6, 2 / 3, 1 / 6), (1 / 6, 1 / 6, 2 / 3)]
    for poly in me.polygons:
        ls = list(poly.loop_indices)
        vs = [me.loops[i].vertex_index for i in ls]
        uvs = [uv[i].uv for i in ls]
        area = max(poly.area, 1e-6)
        for k, vi in enumerate(vs):
            acc[vi] += tex(*uvs[k]) * area
            wt[vi] += area
        if len(vs) == 3:
            for b in bary:
                u = sum(b[k] * uvs[k][0] for k in range(3))
                v = sum(b[k] * uvs[k][1] for k in range(3))
                c = tex(u, v)
                for k, vi in enumerate(vs):
                    acc[vi] += c * area * b[k]
                    wt[vi] += area * b[k]
    col = acc / np.maximum(wt, 1e-9)[:, None]
    # the mean of the hide to camel.py's coat colour, so caravans.ts can tint it by each coat
    mean = (col * wt[:, None]).sum(0) / wt.sum()
    # the texture's baked shade carries a violet cast: keep its light and dark, ease its hue
    lum = col @ np.array([0.3, 0.59, 0.11])
    grey = lum[:, None] * (mean / (mean @ np.array([0.3, 0.59, 0.11])))[None, :]
    col = col * (1 - HUE_KEEP) + grey * HUE_KEEP
    col = col * (np.array(COAT_RGB) / mean)
    col = np.clip(np.round(col * 24.0) / 24.0, 0.0, 1.0)
    return [tuple(float(x) for x in c) for c in col]


# ---------------------------------------------------------------- the body as arrays


def v3(a):
    return Vector(a)


def body_arrays(me, cols):
    pos = [(v.co.x, v.co.z, -v.co.y) for v in me.vertices]  # back to the game frame
    tris = [tuple(me.loops[i].vertex_index for i in p.loop_indices) for p in me.polygons]
    return pos, list(cols), tris


def level_back(pos, tris):
    """The decimation shaves the back a little: bring the hide at the rider's spot (source z
    Z_MID, the top of the back a hand either side of the spine) to BACK_TOP again, above the knees."""
    bvh = BVHTree.FromPolygons([Vector(p) for p in pos], tris)
    ys = [h[0].y for x in (-0.2, -0.1, 0.0, 0.1, 0.2) if (h := bvh.ray_cast(Vector((x, 6, Z_MID)), Vector((0, -1, 0))))[0]]
    k = (BACK_TOP - KNEE_Y) / (max(ys) - KNEE_Y)
    out = [(p[0], p[1] if p[1] < KNEE_Y else KNEE_Y + (p[1] - KNEE_Y) * k, p[2]) for p in pos]
    # the source has a small knob on the hump's crest that would poke through the pad and blanket
    return [(p[0], min(p[1], BACK_TOP + 0.03), p[2]) if abs(p[0]) < 0.25 and abs(p[2] - Z_MID) < 0.5 else p for p in out]


def vertex_normals(pos, tris):
    acc = [Vector((0, 0, 0)) for _ in pos]
    for a, b, c in tris:
        n = (v3(pos[b]) - v3(pos[a])).cross(v3(pos[c]) - v3(pos[a]))
        for i in (a, b, c):
            acc[i] += n
    return [tuple(n.normalized()) if n.length > 1e-12 else (0.0, 1.0, 0.0) for n in acc]


# under the belly, by source z: below it the legs are their own pieces (the forelegs up to the
# elbow, so the whole forearm swings; the hind legs under the thigh, which stays with the body)
def leg_cut(z):
    return 1.78 if z > Z_MID else 1.55


def find_legs(pos, tris):
    """The four legs: the triangles under leg_cut off the midline, in pieces joined by edges,
    that stand on the ground. Returns {(sx, front): set of triangle indices}."""
    def ctr(t, k):
        return sum(pos[i][k] for i in t) / 3

    cand = [f for f, t in enumerate(tris) if ctr(t, 1) < leg_cut(ctr(t, 2)) and abs(ctr(t, 0)) > 0.1]
    cs = set(cand)
    by_edge = {}
    for f in cand:
        t = tris[f]
        for k in range(3):
            e = tuple(sorted((t[k], t[(k + 1) % 3])))
            by_edge.setdefault(e, []).append(f)
    seen, comps = set(), []
    for f in cand:
        if f in seen:
            continue
        comp, stack = set(), [f]
        seen.add(f)
        while stack:
            g = stack.pop()
            comp.add(g)
            t = tris[g]
            for k in range(3):
                e = tuple(sorted((t[k], t[(k + 1) % 3])))
                for h in by_edge[e]:
                    if h not in seen and h in cs:
                        seen.add(h)
                        stack.append(h)
        comps.append(comp)
    legs = {}
    for comp in comps:
        vs = {i for f in comp for i in tris[f]}
        if min(pos[i][1] for i in vs) > 0.1:
            continue
        cx = sum(pos[i][0] for i in vs) / len(vs)
        cz = sum(pos[i][2] for i in vs) / len(vs)
        key = (1 if cx > 0 else -1, 1 if cz > 0 else -1)
        legs.setdefault(key, set()).update(comp)  # a hoof can be a shell of its own
    assert len(legs) == 4, f"found {len(legs)} legs"
    # an even cut: a body triangle with two edges on a leg is a notch, given to the leg; a leg
    # triangle with two edges on the body is a tooth, given back; a body triangle whose corners
    # are all on the leg is a pit
    edge_faces = {}
    for f, t in enumerate(tris):
        for k in range(3):
            edge_faces.setdefault(tuple(sorted((t[k], t[(k + 1) % 3]))), []).append(f)

    def across(f):
        t = tris[f]
        for k in range(3):
            for g in edge_faces[tuple(sorted((t[k], t[(k + 1) % 3])))]:
                if g != f:
                    yield g

    taken = set().union(*legs.values())
    for comp in legs.values():
        for _ in range(4):
            changed = False
            vs = {i for f in comp for i in tris[f]}
            for f, t in enumerate(tris):
                if f in taken:
                    continue
                if sum(g in comp for g in across(f)) >= 2 or all(i in vs for i in t):
                    comp.add(f)
                    taken.add(f)
                    changed = True
            for f in list(comp):
                if min(pos[i][1] for i in tris[f]) > 0.3 and sum(g not in comp for g in across(f)) >= 2:
                    comp.discard(f)
                    taken.discard(f)
                    changed = True
            if not changed:
                break
    return legs


def boundary_loop(tris, comp, on_cut):
    """The leg's open edge against the body, in order, following the leg's own winding."""
    nxt = {}
    edges = {}
    for f in comp:
        t = tris[f]
        for k in range(3):
            edges[(t[k], t[(k + 1) % 3])] = f
    for a, b in edges:
        if (b, a) not in edges and a in on_cut and b in on_cut:
            nxt.setdefault(a, []).append(b)
    loops = []
    left = {a: list(bs) for a, bs in nxt.items()}
    while any(left.values()):
        start = next(a for a, bs in left.items() if bs)
        loop, a = [start], start
        while True:
            b = left[a].pop()
            if b == start:
                break
            loop.append(b)
            a = b
            if not left.get(a):
                break
        loops.append(loop)
    loops.sort(key=len, reverse=True)
    return loops


def seat_legs(pos, tris, legs):
    """The trunk drawn out along z (fit_z); each leg moved, not stretched, so its knee or hock is
    right under its hip, and the hide just above the cut eased along with it so the seam closes."""
    out = []
    on_leg = {}
    for key, comp in legs.items():
        for f in comp:
            for i in tris[f]:
                on_leg[i] = key
    for i, p in enumerate(pos):
        z = fit_z(p[2])
        best = None
        for key in legs:
            sx, front = key
            if (p[0] > 0) != (sx > 0):
                continue
            zj = FRONT_KNEE[1] if front > 0 else HIND_HOCK[1]
            cut = leg_cut(zj)
            t = smoothstep(cut + 0.45, cut - 0.05, p[1])
            if on_leg.get(i) != key:
                # the hide near the leg, not the tail or the belly's midline
                t *= smoothstep(0.75, 0.4, abs(p[2] - zj)) * smoothstep(0.08, 0.2, abs(p[0]))
            if t > 0 and (best is None or t > best[0]):
                best = (t, front * 0.8 + (p[2] - zj))
        if best:
            z = mix(z, best[1], best[0])
        out.append((p[0], p[1], z))
    return out


def build_body(pos, cols, tris):
    """Rig the hide: legs cut free with sleeves, the neck and head, the tail. Returns lists for
    pos, nrm, rig (4), piv, col, tris; the leg sleeves and belly caps are added here."""
    legs = find_legs(pos, tris)
    pos = seat_legs(pos, tris, legs)
    tail = find_tail(pos, tris)
    pos = [(p[0], p[1] + (TAIL_TOP - p[1]) * TAIL_LIFT, p[2]) if i in tail else p for i, p in enumerate(pos)]
    nrm = vertex_normals(pos, tris)  # from the whole hide, so the cut does not show at rest
    n0 = len(pos)
    rig = [None] * n0
    piv = [None] * n0
    pos, cols, nrm = list(pos), list(cols), list(nrm)
    tris = list(tris)
    new_tris = []
    leg_of = {}
    for f, t in enumerate(tris):
        for key, comp in legs.items():
            if f in comp:
                leg_of[f] = key
    body_vs = {i for f, t in enumerate(tris) if f not in leg_of for i in t}
    extra_rig, extra_piv = {}, {}

    def add_vert(p, c, n, r, pv):
        pos.append(tuple(p))
        cols.append(tuple(c))
        nrm.append(tuple(n))
        extra_rig[len(pos) - 1] = r
        extra_piv[len(pos) - 1] = pv
        return len(pos) - 1

    for key, comp in legs.items():
        sx, front = key
        hx, hz, fr, ph = next(lg for lg in LEGS if (1 if lg[0] > 0 else -1) == sx and (1 if lg[1] > 0 else -1) == front)
        pv = (hx, HIP_Y, hz)
        # the leg's own copies of the vertices it shares with the body
        dup = {}
        for f in comp:
            t = list(tris[f])
            for k, i in enumerate(t):
                if i in body_vs:
                    if i not in dup:
                        dup[i] = add_vert(pos[i], cols[i], nrm[i], (ph, 1.0, float(fr), cp["knee_w"](pos[i][1])), pv)
                    t[k] = dup[i]
            tris[f] = tuple(t)
        for f in comp:
            for i in tris[f]:
                if i < n0:
                    rig[i] = (ph, 1.0, float(fr), cp["knee_w"](pos[i][1]))
                    piv[i] = pv
        loops = boundary_loop(tris, comp, set(dup.values()))
        for loop in loops:
            if len(loop) < 3:
                continue
            ring = [v3(pos[i]) for i in loop]
            c = sum(ring, Vector((0, 0, 0))) / len(ring)
            cc = sum(ring, Vector((0, 0, 0))) / len(ring)
            col = tuple(sum(cols[i][j] for i in loop) / len(loop) for j in range(3))
            body_side = {v: k for k, v in dup.items()}
            # the belly's cap over the hole, a fan from its middle, a little up into the body
            ctr = add_vert(c + Vector((0, 0.04, 0)), col, (0, -1, 0), (0.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
            for k in range(len(loop)):
                a, b = body_side[loop[k]], body_side[loop[(k + 1) % len(loop)]]
                new_tris.append((a, b, ctr))
            # the leg's sleeve, up into the body towards the hip, and its lid
            top = Vector((cc.x * 0.7, 2.05, hz))
            r = (ph, 1.0, float(fr), 0.0)
            sleeve = []
            for i in loop:
                d = v3(pos[i]) - cc
                d.y = 0.0
                p = top + d * 0.5
                sleeve.append(add_vert(p, cols[i], tuple(d.normalized()) if d.length > 1e-6 else (0, 1, 0), r, pv))
            lid = add_vert(top + Vector((0, 0.05, 0)), col, (0, 1, 0), r, pv)
            m = len(loop)
            for k in range(m):
                a, b = loop[k], loop[(k + 1) % m]
                ra, rb = sleeve[k], sleeve[(k + 1) % m]
                new_tris.append((b, a, ra))
                new_tris.append((b, ra, rb))
                new_tris.append((rb, ra, lid))

    # neck and head, tail, the rest rigid
    for i in range(n0):
        if rig[i] is not None:
            continue
        p = pos[i]
        piv[i] = (0.0, 0.0, 0.0)
        rig[i] = (0.0, 0.0, 0.0, 0.0)
        if p[2] > NECK_FROM:
            d = math.dist(p, NECK_PIVOT)
            w = smoothstep(NECK_FROM, NECK_FROM + 0.4, p[2]) * smoothstep(0.45, 1.75, d)
            rig[i] = (0.0, 2.0, w, 0.0)
            piv[i] = NECK_PIVOT
        elif i in tail:
            rig[i] = (0.0, 4.0, tail_w(p), 0.0)
            piv[i] = TAIL_ROOT
    for i, r in extra_rig.items():
        while len(rig) <= i:
            rig.append(None)
            piv.append(None)
        rig[i] = r
        piv[i] = extra_piv[i]
    return pos, nrm, rig, piv, cols, tris + new_tris, legs


NECK_FROM = 1.2  # the neck's weight starts at the shoulder's front

# the tail hangs off the rump, about the midline (set from the debug render)
TAIL_TOP, TAIL_TIP = 2.25, 1.35
TAIL_LIFT = 0.4  # the source's tail hangs to the hocks: shortened, its tip clears the ground kneeling


def find_tail(pos, tris):
    """The tail: what hangs from the rump about the midline, found from its tip along its edges
    (it hangs close against the buttocks, so a box would take some of them with it)."""
    nb = {}
    for t in tris:
        for k in range(3):
            nb.setdefault(t[k], set()).update((t[(k + 1) % 3], t[(k + 2) % 3]))

    def ok(i):
        p = pos[i]
        return abs(p[0]) < 0.14 and p[2] < -1.08 and p[1] < TAIL_TOP

    tip = min((i for i in range(len(pos)) if ok(i) and pos[i][1] < 1.6), key=lambda i: pos[i][1])
    seen, stack = {tip}, [tip]
    while stack:
        i = stack.pop()
        for j in nb.get(i, ()):
            if j not in seen and ok(j):
                seen.add(j)
                stack.append(j)
    print("CAMEL tail verts", len(seen), "z", round(min(pos[i][2] for i in seen), 2), round(max(pos[i][2] for i in seen), 2), "y", round(min(pos[i][1] for i in seen), 2), round(max(pos[i][1] for i in seen), 2))
    return seen


def tail_w(p):
    return smoothstep(TAIL_TOP, TAIL_TOP - (TAIL_TOP - TAIL_TIP) * (1 - TAIL_LIFT), p[1])


# ---------------------------------------------------------------- the pad and loads on this back


DRAPE_LIFT = 0.012


class Back:
    """camel.py's trunk_at for the new hide: points on its surface by section angle, cast from
    the middle of the section at z, pushed `off` out along the section's own normal."""

    def __init__(self, pos, tris, rigid):
        keep = [t for t in tris if all(rigid(i) for i in t)]
        self.bvh = BVHTree.FromPolygons([Vector(p) for p in pos], keep)

    def mid(self, z):
        top = self.bvh.ray_cast(Vector((0, 6, z)), Vector((0, -1, 0)))[0]
        bot = self.bvh.ray_cast(Vector((0, -1, z)), Vector((0, 1, 0)))[0]
        if top is None or bot is None:
            return 2.3
        return bot.y + 0.55 * (top.y - bot.y)

    def at(self, z, a, off=0.0):
        cy = self.mid(z)
        o = Vector((0, cy, z))
        d = Vector((math.sin(a), math.cos(a), 0))
        hit, n, _, _ = self.bvh.ray_cast(o, d)
        if hit is None:
            hit, n = o + d * 0.5, d
        n = Vector((n.x, n.y, 0))
        if n.length < 1e-6 or n.dot(d) < 0.2:
            n = d
        n.normalize()
        return tuple(hit + n * off)

    def side_x(self, y, z):
        """How far out the flank is at height y and z."""
        hit = self.bvh.ray_cast(Vector((0, y, z)), Vector((1, 0, 0)))[0]
        return hit.x if hit else 0.45

    def top(self, z):
        """The top of the back at z: its highest line, a hand either side of the spine."""
        ys = [h[0].y for x in (-0.2, -0.1, 0.0, 0.1, 0.2) if (h := self.bvh.ray_cast(Vector((x, 6, z)), Vector((0, -1, 0))))[0]]
        return max(ys) if ys else BACK_TOP


def old_side_x(y, z):
    """The old trunk's flank at height y and z (camel.py's trunk_at, searched by angle)."""
    best = None
    for k in range(400):
        a = math.pi * k / 400
        p = old_trunk_at(z, a)
        if best is None or abs(p[1] - y) < abs(best[1] - y):
            best = p
    return best[0]


def accessories(back):
    """camel.py's saddle pad and loads, built on the new back: the cloth and straps follow it
    through trunk_at; the bundles, jars and the roll keep their shape and are moved to sit on it."""
    cp["trunk_at"] = back.at
    b = cp["Builder"]()
    fixed = []  # vertex ranges laid on the hide already (cloth, straps): not moved again
    real_strap, real_draped = cp["strap"], cp["draped"]

    def strap(bb, part, z, off, *rest):
        n = len(b.pos)
        real_strap(bb, part, z, off + DRAPE_LIFT, *rest)  # still over the blanket
        fixed.append((n, len(b.pos)))

    def draped(bb, z0, z1, a0, a1, nz, fr, off, *rest):
        # this hide is squarer in section than camel.py's trunk: more rows across, so the cloth
        # follows its shoulders instead of cutting under them, and held a little further off
        fine = [fr[0]]
        for u, v in zip(fr, fr[1:]):
            if v - u > 0.1:
                fine.append(0.5 * (u + v))
            fine.append(v)
        n = len(b.pos)
        r = real_draped(bb, z0, z1, a0, a1, nz + 2, fine, off + DRAPE_LIFT, *rest)
        fixed.append((n, len(b.pos)))
        return r

    cp["strap"], cp["draped"] = strap, draped
    cp["saddle"](b)
    body_tris = len(b.tris)

    def seat_sides(fn, yc, zc):
        n = len(b.pos)
        fixed.clear()
        fn(b)
        dx = back.side_x(yc, zc) - old_side_x(yc, zc)
        for i in range(n, len(b.pos)):
            if any(lo <= i < hi for lo, hi in fixed):
                continue
            p = b.pos[i]
            s = 1 if p[0] > 0 else -1
            b.pos[i] = (p[0] + s * dx, p[1], p[2])
        return dx

    dxb = seat_sides(cp["bundles"], 2.52, 0.04)
    dxj = seat_sides(cp["jars"], 2.52, 0.1)
    # the blanket drapes itself; the roll on top goes up or down with the back under it
    n = len(b.pos)
    fixed.clear()
    cp["blanket"](b)
    dy = back.top(-0.12) - old_trunk_at(-0.12, 0.0)[1]
    for i in range(n, len(b.pos)):
        if not any(lo <= i < hi for lo, hi in fixed):
            p = b.pos[i]
            b.pos[i] = (p[0], p[1] + dy, p[2])
    cp["strap"], cp["draped"], cp["trunk_at"] = real_strap, real_draped, old_trunk_at
    print(f"CAMEL back at z 0: {back.top(0.0):.3f}, hump crest {max(back.top(z / 20) for z in range(-20, 21)):.3f}")
    print(f"CAMEL loads moved: bundles dx {dxb:+.3f}, jars dx {dxj:+.3f}, roll dy {dy:+.3f}")
    return b, body_tris


# ---------------------------------------------------------------- export


def export(model, acol):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    pos, nrm, rig, piv, mp, tris = model
    ob = cp["make_mesh"]("camel", pos, nrm, tris)
    me = ob.data
    set_attr = cp["set_attr"]
    set_attr(me, "_arig", "FLOAT2", [(r[0], r[1]) for r in rig])
    set_attr(me, "_arigzw", "FLOAT2", [(r[2], r[3]) for r in rig])
    set_attr(me, "_apivot", "FLOAT_VECTOR", piv)
    set_attr(me, "_amp", "FLOAT2", mp)
    set_attr(me, "_acol", "FLOAT_VECTOR", acol)
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


def convert():
    ob, img = load_source()
    me, tris0 = decimate(ob)
    cols = bake_colours(me, img)
    pos, cols, tris = body_arrays(me, cols)
    pos = level_back(pos, tris)
    hide_tris = len(tris)
    pos, nrm, rig, piv, cols, tris, legs = build_body(pos, cols, tris)
    nb = len(pos)
    leg_vs = {i for comp in legs.values() for f in comp for i in tris[f]}
    back = Back(pos, tris[: hide_tris], lambda i: i not in leg_vs and rig[i][1] == 0.0)
    b, saddle_tris = accessories(back)
    apos, anrm, arig, apiv, amp, atris = cp["finish"](b)
    # the hide, then camel.py's pieces
    out_pos = list(pos) + list(apos)
    out_nrm = list(nrm) + list(anrm)
    out_rig = list(rig) + list(arig)
    out_piv = list(piv) + list(apiv)
    out_mp = [(float(COAT), 0.0)] * nb + list(amp)
    out_col = list(cols) + [(0.0, 0.0, 0.0)] * len(apos)
    out_tris = list(tris) + [(a + nb, c + nb, d + nb) for a, c, d in atris]
    out_pos = [(p[0], max(0.0, p[1]), p[2]) for p in out_pos]
    model = (out_pos, out_nrm, out_rig, out_piv, out_mp, out_tris)
    export(model, out_col)
    parts = {}
    for t in out_tris:
        p = int(out_mp[t[0]][1])
        parts[p] = parts.get(p, 0) + 1
    body = len(tris) + saddle_tris
    print("CAMEL source tris", tris0, "hide", hide_tris, "hide+sleeves", len(tris), "body with pad", body, "by part", parts)
    print("CAMEL verts", len(out_pos), "file", OUT, os.path.getsize(OUT))
    return model, out_col


# ---------------------------------------------------------------- previews

REGION = {0: (0.75, 0.75, 0.72), 2: (0.2, 0.45, 0.95), 3: (0.95, 0.85, 0.2), 4: (0.85, 0.2, 0.75), 5: (0.95, 0.85, 0.2)}


def preview(model, acol, out_dir):
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
    ground = bpy.context.active_object
    ground.data.materials.append(sand)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam
    _, nrm, rig, piv, mp, tris = model
    add, sub = cp["add"], cp["sub"]

    def build(pos, variant=0, x_off=0.0, debug=False):
        keep = [i for i, t in enumerate(tris) if all(mp[v][1] < 0.5 or (int(variant) // int(mp[v][1])) % 2 == 1 for v in t)]
        ob = cp["make_mesh"]("camel_p", [add(p, (x_off, 0, 0)) for p in pos], nrm, [tris[i] for i in keep])
        a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
        cs = []
        for (o, kind, z, w), m, ac in zip(rig, mp, acol):
            if debug:
                if kind == 1:
                    base = (0.95, 0.35, 0.2) if z > 0 else (0.25, 0.8, 0.3)
                    c = tuple(x * (1 - 0.65 * w) for x in base)  # darker below the knee
                else:
                    c = REGION.get(int(kind), (1, 1, 1))
                    if kind in (2, 4):
                        c = tuple(mix(0.85, x, z) for x in c)  # pale at the root
            elif sum(ac) > 0.001 and m[0] < 3.5:
                c = ac
            else:
                c = cp["colour"](int(m[0]))
                if kind in (3, 5):
                    c = tuple(x * (1 - 0.22 * z) for x in c)
            cs.extend((*(x**2.2 for x in c), 1.0))
        a.data.foreach_set("color", cs)
        ob.data.materials.append(mat)
        return ob

    def aim(target, eye):
        d = sub(target, eye)
        cam.location = eye
        cam.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[0], -d[1]) + math.pi)

    def shoot(name):
        sc.render.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)

    g = cp["to_blender"]
    posed = cp["posed"]
    shots = [
        ("stand", posed(model), 0, False),
        ("stride", posed(model, g=1.0, ph=0.25), 0, False),
        ("stride2", posed(model, g=1.0, ph=0.75), 0, False),
        ("halfkneel", posed(model, sit=0.5), 0, False),
        ("kneel", posed(model, sit=1.0), 0, False),
        ("load1", posed(model), 1, False),
        ("load2", posed(model), 2, False),
        ("load4", posed(model), 4, False),
        ("kneel_load5", posed(model, sit=1.0), 5, False),
        ("graze", posed(model, bow=1.4), 0, False),
        ("debug", posed(model), 0, True),
        ("debug_kneel", posed(model, sit=1.0), 0, True),
        ("debug_stride", posed(model, g=1.0, ph=0.25), 0, True),
    ]
    for name, pos, variant, debug in shots:
        ob = build(pos, variant, 0.0, debug)
        cam.data.ortho_scale = 5.6
        aim(g((0, 1.7, 0.6)), g((-12, 1.7, 0.6)))
        shoot(f"camel_{name}_side.png")
        aim(g((0, 1.6, 0.5)), g((-8.5, 5.5, 8.0)))
        shoot(f"camel_{name}_34.png")
        if name in ("stride", "stride2", "kneel", "halfkneel"):
            cam.data.ortho_scale = 2.4
            aim(g((0, 1.9 - 1.2 * (name.endswith("kneel")), -0.9)), g((-5.0, 3.6, -7.5)))
            shoot(f"camel_{name}_hip.png")
            cam.data.ortho_scale = 5.6
        if name in ("kneel", "stride", "debug_kneel", "stand"):
            aim(g((0, 1.3, 0.0)), g((-6.0, 2.4, -8.0)))
            shoot(f"camel_{name}_back.png")
            ground.hide_render = True
            aim(g((0, 1.2, 0.3)), g((-3.0, -6.0, 0.31)))
            shoot(f"camel_{name}_under.png")
            ground.hide_render = False
        bpy.data.objects.remove(ob)
    ob = build(posed(model), 0)
    cam.data.ortho_scale = 1.8
    aim(g((0, 3.0, 2.2)), g((-6, 3.6, 4.6)))
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
    model, acol = convert()
    if "--preview" in argv:
        preview(model, acol, argv[argv.index("--preview") + 1])


main()
