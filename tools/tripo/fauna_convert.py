"""The Tripo animals (tools/tripo/source/*.glb) turned into public/art/fauna.glb, with the rig the
fauna vertex shader of src/world/fauna.ts animates.

    blender --background --python tools/tripo/fauna_convert.py                          # write the .glb
    blender --background --python tools/tripo/fauna_convert.py -- --preview DIR          # and render each animal
    blender --background --python tools/tripo/fauna_convert.py -- --only fox --preview DIR   # look at some (no .glb)

Each species: the Tripo mesh is imported, welded and decimated to its triangle budget, turned into
the game's frame (metres, +Y up, feet at 0, facing +Z) and sized to the hand-made animal of
tools/blender/fauna.py (the ass's and oryx's back at the riding height). Its texture is baked into
a colour per vertex (sampled over the faces round it on the full-resolution mesh, then posterised
to a few colours per species), written as _acol: the colour as shown, the same space as the coats
of fauna.ts, which the shader writes out unconverted. _amat is the nearest of the species' coat
materials, so the coat-relative tint of fauna.ts (goat coats, snow coats) still applies.

The rig follows fauna.py's conventions (see its docstring for every value): the legs are the parts
of the mesh below the belly line that reach the ground, each turning about a hip / shoulder pivot
at fauna.py's height with fauna.py's phase. The mesh is one piece, so where a part meets the body
the motion is blended: aPivot is per vertex, and turning a vertex by an angle about a pivot moved
from the joint towards the vertex by (1 - w) of the way is exactly the joint's motion scaled by w,
so a leg's top, the tail's root and a wing's root fade into the still body without tearing. The
neck and head take the head weight (aRig.z) rising from the neck base, the tail its weight along
the tail, the wings their side weight rising from the wing root. Ears stay with the head (kind 2):
their flick turns about the neck base and would tear a fused ear.

Fixes to the poses the shader starts from: uncoil_snake() lays the coiled snake out along +Z (the
shader lays it in its S), but its tail tip lies against its raised neck and the result forks at the
head, so the snake is kept hand-made (KEEP) for now. The vulture's raised wings are lowered to the flat glide fauna.py modelled, and the
sandgrouse keeps its folded Tripo wings painted on and gets fauna.py's spread wings, which the
shader folds along its flanks on the ground and beats in the air.
Any species listed in KEEP is exported as fauna.py builds it (no _acol: the coat lookup).
"""

import heapq
import math
import os
import runpy
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "source")
OUT = os.path.join(ROOT, "public", "art", "fauna.glb")
FAUNA_PY = os.path.join(ROOT, "tools", "blender", "fauna.py")

ORYX, FOX, HARE, LIZARD, VULTURE, GAZELLE, ASS, GOAT, TORTOISE, SNAKE, GROUSE = range(11)
NAMES = ["oryx", "fox", "hare", "lizard", "vulture", "gazelle", "ass", "goat", "tortoise", "snake", "grouse"]
# fauna.ts SPEC coats: _acol is divided by these for the coat materials and tinted by each animal's coat
SPEC_COAT = [
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

# species exported as fauna.py builds them
KEEP = {SNAKE}

# ---------------------------------------------------------------- per species
#
# head: which way the Tripo head points in the imported (Blender) frame, "-y" or "+y".
# fit:  ("back", y, z) puts the top of the back at z at height y; ("len", L) makes the length L;
#       ("span", S) makes the wing span S.
# tris: the triangle budget.  pal: colours in the posterised palette.
# legs: [(side, front, phase)], the hand-made phases; hy: hip / shoulder pivot heights (hind, front);
#       cut: the belly line, as a fraction of the back height; band: blend above it (fraction).
# np_: neck base pivot (game frame, after fitting); axis: up the neck; nd: (blend start, full) along
#       the axis from the pivot (m); nmin: the least axis distance that is still neck.
# tail: (root pivot, direction, length, z below which it is tail, y above which).
# wing: (root |x|, blend width, pivot y, pivot z)

H4 = [(1, 1, 0.0), (-1, 1, 0.5), (1, -1, 0.5), (-1, -1, 0.0)]  # hoofed, fox, lizard, tortoise

CFG = {
    ORYX: dict(head="-y", fit=("back", 1.30, 0.0), tris=2000, pal=8, legs=H4, hy=(0.9, 0.9), cut=0.62, band=0.12,
               np_=(0.0, 1.12, 0.6), axis=(0.0, 0.62, 0.78), nd=(-0.02, 0.32), nmin=-0.02,
               tail=((0.0, 1.0, -0.72), (0.0, -0.6, -0.8), 0.45, -0.66, 0.5)),
    GAZELLE: dict(head="-y", fit=("back", 0.79, 0.0), tris=2000, pal=8, legs=H4, hy=(0.6, 0.6), cut=0.64, band=0.12,
                  np_=(0.0, 0.72, 0.36), axis=(0.0, 0.62, 0.78), nd=(-0.02, 0.22), nmin=-0.02,
                  tail=((0.0, 0.64, -0.36), (0.0, -0.6, -0.8), 0.12, -0.33, 0.45)),
    ASS: dict(head="+y", fit=("back", 1.30, 0.0), tris=2000, pal=8, legs=H4, hy=(0.94, 0.94), cut=0.62, band=0.12,
              np_=(0.0, 1.12, 0.56), axis=(0.0, 0.6, 0.8), nd=(-0.02, 0.34), nmin=-0.02,
              tail=((0.0, 1.04, -0.72), (0.0, -0.8, -0.6), 0.6, -0.66, 0.3)),
    GOAT: dict(head="+y", fit=("back", 0.775, 0.0), tris=2000, pal=8, norm=1.0, legs=H4, hy=(0.54, 0.54), cut=0.6, band=0.12,
               np_=(0.0, 0.64, 0.32), axis=(0.0, 0.62, 0.78), nd=(-0.02, 0.2), nmin=-0.02,
               tail=((0.0, 0.64, -0.36), (0.0, 0.6, -0.8), 0.12, -0.35, 0.5)),
    FOX: dict(head="-y", fit=("back", 0.28, 0.0), tris=1500, pal=7, legs=H4, hy=(0.2, 0.2), cut=0.62, band=0.12,
              np_=(0.0, 0.22, 0.11), axis=(0.0, 0.6, 0.8), nd=(-0.01, 0.06), nmin=-0.01,
              tail=((0.0, 0.2, -0.18), (0.0, -0.5, -0.86), 0.32, -0.17, 0.0)),
    HARE: dict(head="+y", fit=("len", 0.5), tris=1500, pal=7, legs=[(1, -1, 0.0), (-1, -1, 0.0), (1, 1, 0.5), (-1, 1, 0.5)],
               hy=(0.15, 0.17), cut=0.55, band=0.25, ref=0.3,
               np_=(0.0, 0.24, 0.13), axis=(0.0, 0.6, 0.8), nd=(-0.01, 0.08), nmin=-0.01, nback=0.3, tail=None),
    LIZARD: dict(head="+y", fit=("len", 0.40), tris=900, pal=7, point=0.6, legs=H4, hy=(0.05, 0.05), cut=1.0, band=0.3, ref=0.05,
                 np_=None, tail=((0.0, 0.03, -0.06), (0.0, 0.0, -1.0), 0.2, -0.06, -1.0)),
    TORTOISE: dict(head="-y", fit=("len", 0.50), tris=1500, pal=7, point=0.4, legs=H4, hy=(0.06, 0.06), cut=1.0, band=0.2, ref=0.12, head_z=0.17, head_y=0.05, head_x=0.045,
                   np_=(0.0, 0.06, 0.17), axis=(0.0, 0.0, 1.0), nd=(0.0, 0.0), nmin=0.0, tail=None),
    SNAKE: dict(head="snake", fit=("len", 0.645), tris=900, pal=6, legs=[], np_=None, tail=None),
    VULTURE: dict(head="-y", fit=("span", 3.0), tris=1500, pal=7, legs=[], np_=None, tail=None,
                  wing=(0.12, 0.25, 0.02, 0.0)),
    GROUSE: dict(head="+y", fit=("len", 0.41), tris=900, pal=7, point=0.4, legs=[(1, 0, 0.0), (-1, 0, 0.5)], hy=(0.08, 0.08), cut=0.45, band=0.2, ref=0.16, autocut=False,
                 np_=(0.0, 0.23, 0.06), axis=(0.0, 0.7, 0.7), nd=(0.0, 0.04), nmin=0.0, ny=0.2, tail=None),
}

# ---------------------------------------------------------------- hand-made models (fauna.py)


def handmade():
    """fauna.py's finished models, [(pos, nrm, rig, piv, mp, tris)] by species (its main() only
    builds them when given --only, and writes nothing)."""
    argv = sys.argv
    sys.argv = [argv[0], "--", "--only", "oryx"]
    try:
        g = runpy.run_path(FAUNA_PY, run_name="fauna_py")
    finally:
        sys.argv = argv
    return [g["finish"](f()) for f in g["BUILDERS"]]


# ---------------------------------------------------------------- import and decimate


def load_tripo(name, budget):
    """The Tripo mesh, welded: the full mesh (game frame, triangles, corner uvs, texture) for
    sampling and the decimated one (positions, triangles)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, name + ".glb"))
    obs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    img = None
    for o in obs:
        for m in o.data.materials:
            if m and m.node_tree:
                for n in m.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image and img is None:
                        img = n.image
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    size = max(ob.dimensions)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=size * 1e-5)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    # the full mesh, for sampling the texture
    uvl = me.uv_layers.active.data
    fpos = np.array([to_game(v.co) for v in me.vertices])
    ftri = np.array([[me.loops[li].vertex_index for li in p.loop_indices] for p in me.polygons])
    fuv = np.array([[tuple(uvl[li].uv) for li in p.loop_indices] for p in me.polygons])
    w, h = img.size
    tex = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[:, :, :3]
    ntri = len(me.polygons)
    mod = ob.modifiers.new("dec", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = min(1.0, budget / ntri * 0.995)
    mod.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    em = ob.evaluated_get(dg).to_mesh()
    dpos = np.array([to_game(v.co) for v in em.vertices])
    dtri = np.array([list(p.vertices) for p in em.polygons])
    ob.evaluated_get(dg).to_mesh_clear()
    print(f"TRIPO {name}: {ntri} tris -> {len(dtri)}, {len(dpos)} verts")
    return dict(fpos=fpos, ftri=ftri, fuv=fuv, tex=tex), dpos, dtri


def to_game(co):
    """Blender (x, y, z up) to the game's (x, y up, z forward)."""
    return (co[0], co[2], -co[1])


def to_blender(p):
    return (p[0], -p[2], p[1])


# ---------------------------------------------------------------- fitting


def orient(pts, head):
    """Turn the imported mesh so the head points +Z (Blender -y is the game's +z)."""
    if head == "+y":
        pts = pts * np.array([-1.0, 1.0, -1.0])
    return pts


def fit(sp, cfg, full, pos):
    """Scale and place: uniform scale, x centred, feet on the ground, z by the legs or the bbox.
    The same transform is put on the full mesh (it is sampled in the fitted frame)."""
    kind = cfg["fit"]
    p = pos.copy()
    lo, hi = p.min(0), p.max(0)
    c = (lo + hi) / 2
    p = p - np.array([c[0], lo[1], c[2]])
    if kind[0] == "back":
        H = p[:, 1].max()
        feet = p[p[:, 1] < 0.04 * H]
        zc = (feet[:, 2].min() + feet[:, 2].max()) / 2
        near = p[np.abs(p[:, 2] - zc) < 0.06 * (hi[2] - lo[2])]
        s = kind[1] / near[:, 1].max()
        dz = kind[2] - zc * s
    elif kind[0] == "len":
        s = kind[1] / (p[:, 2].max() - p[:, 2].min())
        dz = None
    else:  # span
        s = kind[1] / (p[:, 0].max() - p[:, 0].min())
        dz = None
    off = np.array([-c[0], -lo[1], -c[2]])
    return s, off, dz


def apply_fit(pts, s, off, dz):
    q = (pts + off) * s
    if dz is not None:
        q[:, 2] += dz
    return q


# ---------------------------------------------------------------- colour


def sampler(full):
    """The texture colour at the point of the full mesh nearest a point."""
    fpos, ftri, fuv, tex = full["fpos"], full["ftri"], full["fuv"], full["tex"]
    h, w = tex.shape[:2]
    bvh = BVHTree.FromPolygons([Vector(v) for v in fpos], [tuple(int(i) for i in t) for t in ftri])

    def at(q):
        loc, _, fi, _ = bvh.find_nearest(Vector(q))
        if fi is None:
            return None
        tri = ftri[fi]
        uv = fuv[fi]
        u = barycentric_transform(loc, Vector(fpos[tri[0]]), Vector(fpos[tri[1]]), Vector(fpos[tri[2]]), Vector((*uv[0], 0)), Vector((*uv[1], 0)), Vector((*uv[2], 0)))
        x = int(min(w - 1, max(0, (u[0] % 1.0) * w)))
        y = int(min(h - 1, max(0, (u[1] % 1.0) * h)))
        return tex[y, x]

    return at


def sample_colours(at, pos, tris):
    """A colour per face of the decimated mesh: the texture averaged at a few points of the face."""
    bary = [(1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)]
    fcol = np.zeros((len(tris), 3))
    for f, t in enumerate(tris):
        a, b, c = pos[t[0]], pos[t[1]], pos[t[2]]
        cs = [at(a * wa + b * wb + c * wc) for wa, wb, wc in bary]
        cs = [x for x in cs if x is not None]
        fcol[f] = np.mean(cs, 0) if cs else 0.5
    return fcol


def face_areas(pos, tris):
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def vertex_colours(pos, tris, fcol):
    area = face_areas(pos, tris) + 1e-12
    acc = np.zeros((len(pos), 3))
    wsum = np.zeros(len(pos))
    for k in range(3):
        np.add.at(acc, tris[:, k], fcol * area[:, None])
        np.add.at(wsum, tris[:, k], area)
    return acc / np.maximum(wsum, 1e-12)[:, None], wsum


def kmeans(x, wt, k, iters=30):
    """Weighted k-means; returns the palette and each point's colour index."""
    rng = np.random.default_rng(1)
    k = min(k, len(x))
    # seed: farthest-point from the weighted mean
    cent = [x[np.argmax(wt)]]
    for _ in range(k - 1):
        d = np.min([np.sum((x - c) ** 2, 1) for c in cent], 0)
        cent.append(x[np.argmax(d * wt)])
    cent = np.array(cent)
    for _ in range(iters):
        lab = np.argmin(((x[:, None, :] - cent[None]) ** 2).sum(2), 1)
        for j in range(k):
            m = lab == j
            if m.any():
                cent[j] = (x[m] * wt[m, None]).sum(0) / wt[m].sum()
            else:
                cent[j] = x[rng.integers(len(x))]
    lab = np.argmin(((x[:, None, :] - cent[None]) ** 2).sum(2), 1)
    return cent, lab


def material_colours(sp):
    """fauna.ts's material colours for the species' own coat, by aMP.x."""
    c = np.array(SPEC_COAT[sp])
    return np.array([c, c * 0.42, c + (np.array([0.95, 0.92, 0.86]) - c) * 0.6, (0.13, 0.11, 0.1), (0.05, 0.04, 0.04), c * np.array([1.08, 0.82, 0.76])])


# ---------------------------------------------------------------- geometry helpers


def adjacency(n, tris):
    nb = [set() for _ in range(n)]
    for a, b, c in tris:
        nb[a].update((b, c))
        nb[b].update((a, c))
        nb[c].update((a, b))
    return nb


def components(mask, nb):
    """Connected components of the vertices in mask."""
    seen = np.zeros(len(mask), bool)
    out = []
    for v in np.nonzero(mask)[0]:
        if seen[v]:
            continue
        stack, comp = [v], []
        seen[v] = True
        while stack:
            u = stack.pop()
            comp.append(u)
            for w in nb[u]:
                if mask[w] and not seen[w]:
                    seen[w] = True
                    stack.append(w)
        out.append(np.array(comp))
    return out


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0) if b != a else (x >= a).astype(float)
    return t * t * (3 - 2 * t)


def vertex_normals(pos, tris):
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    vn = np.zeros_like(pos)
    for k in range(3):
        np.add.at(vn, tris[:, k], fn)
    ln = np.linalg.norm(vn, axis=1)
    vn[ln < 1e-12] = (0, 1, 0)
    return vn / np.maximum(ln, 1e-12)[:, None]


def outward(pos, tris):
    """Wind the triangles outward (positive volume)."""
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    ctr = pos.mean(0)
    vol = np.sum(np.einsum("ij,ij->i", a - ctr, np.cross(b - ctr, c - ctr)))
    return tris if vol >= 0 else tris[:, [0, 2, 1]]


# ---------------------------------------------------------------- pose fixes


def uncoil_snake(pos, tris):
    """Lay a coiled snake out straight along +Z, head forward: each vertex keeps its offset from
    the body's centre line (in a frame carried along it), placed at its distance along the line."""
    n = len(pos)
    nb = adjacency(n, tris)

    def dijkstra(src):
        d = np.full(n, np.inf)
        d[src] = 0.0
        q = [(0.0, src)]
        while q:
            du, u = heapq.heappop(q)
            if du > d[u]:
                continue
            for w in nb[u]:
                nd = du + float(np.linalg.norm(pos[u] - pos[w]))
                if nd < d[w]:
                    d[w] = nd
                    heapq.heappush(q, (nd, w))
        return d

    top = int(np.argmax(pos[:, 1]))  # the raised head
    tail = int(np.argmax(dijkstra(top)))
    head = int(np.argmax(dijkstra(tail)))
    s = dijkstra(tail)
    L = s[head]
    nb_ = 48
    edges = np.linspace(0, L, nb_ + 1)
    cl = []
    for i in range(nb_):
        m = (s >= edges[i]) & (s <= edges[i + 1])
        cl.append(pos[m].mean(0) if m.any() else (cl[-1] if cl else pos[tail]))
    cl = np.array(cl)
    for _ in range(3):  # smooth the line
        cl[1:-1] = 0.25 * cl[:-2] + 0.5 * cl[1:-1] + 0.25 * cl[2:]
    # the line's own arc length, from tail to head, ends extended to the tips
    cl = np.vstack([pos[tail], cl, pos[head]])
    seg = np.linalg.norm(np.diff(cl, axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(seg)])
    # each vertex onto the nearest point of the line, near its own geodesic distance
    sv = np.zeros(n)
    for v in range(n):
        best, bs = np.inf, 0.0
        for i in range(len(cl) - 1):
            a, b = cl[i], cl[i + 1]
            ab = b - a
            t = np.clip(np.dot(pos[v] - a, ab) / max(np.dot(ab, ab), 1e-12), 0, 1)
            sa = arc[i] + t * seg[i]
            if abs(sa / arc[-1] - s[v] / L) > 0.2:
                continue
            d = np.linalg.norm(pos[v] - (a + ab * t))
            if d < best:
                best, bs = d, sa
        sv[v] = bs if best < np.inf else s[v] / L * arc[-1]
    # frames carried along the line (parallel transport), starting with world up
    tang = np.diff(cl, axis=0)
    tang /= np.maximum(np.linalg.norm(tang, axis=1), 1e-12)[:, None]
    ups = []
    u = np.array([0.0, 1.0, 0.0])
    for t in tang:
        u = u - t * np.dot(u, t)
        if np.linalg.norm(u) < 1e-6:
            u = np.array([0.0, 0.0, 1.0]) - t * t[2]
        u /= np.linalg.norm(u)
        ups.append(u.copy())
    ups = np.array(ups)
    out = np.zeros_like(pos)
    for v in range(n):
        i = int(np.clip(np.searchsorted(arc, sv[v]) - 1, 0, len(tang) - 1))
        t = np.clip((sv[v] - arc[i]) / max(seg[i], 1e-12), 0, 1)
        c = cl[i] + (cl[i + 1] - cl[i]) * t
        T, U = tang[i], ups[i]
        X = np.cross(U, T)  # left of the line, looking along it
        d = pos[v] - c
        out[v] = (np.dot(d, X), np.dot(d, U), sv[v] + np.dot(d, T))
    out[:, 1] -= out[:, 1].min()
    return out


def lower_wings(pos, root_x, root_y):
    """Bring a vulture's raised wings down to a flat glide: each wing turned about the z axis
    through its root by its own lift, blended in over the first part of the wing."""
    out = pos.copy()
    for s in (-1, 1):
        side = (pos[:, 0] * s) > root_x
        q = pos[side]
        far = q[np.abs(q[:, 0]) > np.abs(q[:, 0]).max() * 0.55]
        # the wing's lift: the mean slope from the root to its outer half
        ang = math.atan2(np.median(far[:, 1]) - root_y, np.median(np.abs(far[:, 0])) - root_x)
        target = math.atan2(-0.03, 1.0)  # fauna.py's slight droop
        a = -(ang - target) * s
        x = np.abs(pos[:, 0]) - root_x
        wgt = smoothstep(0.0, 0.25, x / (np.abs(q[:, 0]).max() - root_x)) * side
        rel = pos - np.array([s * root_x, root_y, 0.0])
        ca, sa = np.cos(a * wgt), np.sin(a * wgt)
        rx = rel[:, 0] * ca - rel[:, 1] * sa
        ry = rel[:, 0] * sa + rel[:, 1] * ca
        m = side
        out[m, 0] = s * root_x + rx[m]
        out[m, 1] = root_y + ry[m]
        print(f"VULTURE wing {s}: lift {math.degrees(ang):.1f} deg, turned {math.degrees(a):.1f}")
    return out


# ---------------------------------------------------------------- rig


def rig(sp, cfg, pos, tris):
    """Per vertex: (phase, kind, z, w), pivot. Pivots of blended vertices are moved toward them."""
    n = len(pos)
    nb = adjacency(n, tris)
    kind = np.zeros(n)
    ph = np.zeros(n)
    zw = np.zeros(n)
    ww = np.zeros(n)
    piv = np.zeros((n, 3))
    weight = np.ones(n)  # for leg / wing blending through the pivot
    H = pos[:, 1].max()
    region = np.full(n, "body", dtype=object)

    # legs
    legs = cfg.get("legs") or []
    if legs:
        back = cfg["fit"][1] if cfg["fit"][0] == "back" else None
        ref = back or cfg.get("ref", H)
        # each side on its own: legs that touch at the chest still part. The cut: the belly line
        # between the legs, a little under it
        if cfg.get("autocut", True):
            feet = pos[pos[:, 1] < 0.04 * ref]
            zc = (feet[:, 2].min() + feet[:, 2].max()) / 2
            mid = pos[(np.abs(pos[:, 2] - zc) < 0.06 * np.ptp(pos[:, 2])) & (pos[:, 1] > 0.1 * ref)]
            belly = mid[:, 1].min() if len(mid) else cfg["cut"] * ref
            cfg["cut"] = min(cfg["cut"], (belly - 0.03 * ref) / ref)
            print(f"RIG {NAMES[sp]}: belly {belly:.3f}")
        cut = cfg["cut"] * ref
        print(f"RIG {NAMES[sp]}: cut {cut:.3f}")
        comps = []
        for s in (-1, 1):
            cand = (pos[:, 1] < cut) & (pos[:, 0] * s > 0)
            # a leg reaches the ground and is short along the body (not the tail lying on it)
            comps += [c for c in components(cand, nb) if pos[c, 1].min() < 0.2 * cut and np.ptp(pos[c, 2]) < 0.3 * np.ptp(pos[:, 2])]
        comps.sort(key=len, reverse=True)
        comps = comps[: len(legs)]
        used = set()
        for side, front, phase in legs:
            # the component in this quadrant
            best = None
            for k, c in enumerate(comps):
                if k in used:
                    continue
                cx, cz = pos[c, 0].mean(), pos[c, 2].mean()
                zc = np.mean([pos[cc, 2].mean() for cc in comps])
                if np.sign(cx) != side:
                    continue
                if front != 0 and np.sign(cz - zc) != front:
                    continue
                best = k
            if best is None:
                print(f"RIG {NAMES[sp]}: no leg for side {side} front {front}")
                continue
            used.add(best)
            c = comps[best]
            top = c[pos[c, 1] > np.percentile(pos[c, 1], 80)]
            hy = cfg["hy"][0 if front < 0 else 1]
            pv = np.array([pos[top, 0].mean(), hy, pos[top, 2].mean()])
            kind[c] = 1
            ph[c] = phase
            piv[c] = pv
            region[c] = "leg"
            # the blend above the belly line, round the leg's top
            band = cfg.get("band", 0.0) * ref
            if band > 0:
                cut = cfg["cut"] * ref
                ring = c[pos[c, 1] > cut - 0.04 * ref]
                if len(ring) < 3:
                    ring = top
                cx, cz = pos[ring, 0].mean(), pos[ring, 2].mean()
                r = np.hypot(pos[ring, 0] - cx, pos[ring, 2] - cz).max() * cfg.get("bandr", 1.2)
                d = np.hypot(pos[:, 0] - cx, pos[:, 2] - cz)
                m = (pos[:, 1] >= cut) & (pos[:, 1] < cut + band) & (d < r) & (kind == 0)
                wgt = 1 - smoothstep(cut, cut + band, pos[m, 1])
                idx = np.nonzero(m)[0]
                kind[idx] = 1
                ph[idx] = phase
                piv[idx] = pv
                weight[idx] = wgt
                region[idx] = "legband"
            print(f"RIG {NAMES[sp]} leg side {side} front {front}: {len(c)} verts, pivot {np.round(pv, 3)}")

    # neck and head
    if cfg.get("np_") is not None:
        NP = np.array(cfg["np_"])
        if sp == TORTOISE:
            m = (pos[:, 2] > cfg["head_z"]) & (pos[:, 1] > cfg["head_y"]) & (np.abs(pos[:, 0]) < cfg["head_x"]) & (kind == 0)
            kind[m] = 2
            zw[m] = 1
            piv[m] = NP
            region[m] = "head"
        else:
            ax = np.array(cfg["axis"]) / np.linalg.norm(cfg["axis"])
            d = (pos - NP) @ ax
            m = (d > cfg["nmin"]) & (kind == 0) & (pos[:, 2] > NP[2] - cfg.get("nback", 0.15 * H))
            if "ny" in cfg:
                m &= pos[:, 1] > cfg["ny"]
            kind[m] = 2
            zw[m] = smoothstep(cfg["nd"][0], cfg["nd"][1], d[m])
            piv[m] = NP
            region[m] = "neck"

    # tail
    if cfg.get("tail"):
        TR, tdir, tl, tz, ty = cfg["tail"]
        TR = np.array(TR)
        m = (pos[:, 2] < tz) & (pos[:, 1] > ty) & (kind == 0)
        if "tx" in cfg:
            m &= np.abs(pos[:, 0]) < cfg["tx"]
        kind[m] = 3
        dist = np.linalg.norm(pos[m] - TR, axis=1)
        zw[m] = np.clip(dist / tl, 0, 1) ** 1.2
        piv[m] = TR
        region[m] = "tail"

    # wings
    if cfg.get("wing"):
        rx, bw, py, pz = cfg["wing"]
        for s in (-1, 1):
            m = (pos[:, 0] * s > rx) & (kind == 0)
            kind[m] = 5
            zw[m] = s * smoothstep(rx, rx + bw, np.abs(pos[m, 0]))
            piv[m] = (s * rx, py, pz)
            region[m] = "wing"

    # blend through the pivot: a leg vertex of weight w turns about p - w (p - pivot)
    legm = kind == 1
    piv[legm] = pos[legm] - weight[legm, None] * (pos[legm] - piv[legm])
    rigv = np.stack([ph, kind, zw, ww], 1)
    return rigv, piv, region


# ---------------------------------------------------------------- one species


def convert(sp, hm):
    cfg = CFG[sp]
    name = NAMES[sp]
    full, pos, tris = load_tripo(name, cfg["tris"])
    fp = full["fpos"]
    if cfg["head"] == "snake":
        pts = pos
    else:
        pos = orient(pos, cfg["head"])
        fp = orient(fp, cfg["head"])
    full["fpos"] = fp
    tris = outward(pos, tris)
    # colours: sampled where the mesh is still as Tripo made it
    at = sampler(full)
    fcol = sample_colours(at, pos, tris)
    vcol, varea = vertex_colours(pos, tris, fcol)
    k = cfg.get("point", 0.0)
    if k > 0:
        # small spotted hides: the texture right at each vertex counts too, so the spots survive
        vcol = (1 - k) * vcol + k * np.array([at(p) for p in pos])
    # pose fixes, then the fit
    if sp == SNAKE:
        pts = uncoil_snake(pos, tris)
        # head toward +z
        pos = pts
    if sp == VULTURE:
        lo, hi = pos.min(0), pos.max(0)
        c = (lo + hi) / 2
        body = pos[np.abs(pos[:, 0] - c[0]) < 0.1 * (hi[0] - lo[0])]
        pos = pos - np.array([c[0], np.median(body[:, 1]), 0.0])
        pos = lower_wings(pos, 0.04 * (hi[0] - lo[0]), 0.0)
    s, off, dz = fit(sp, cfg, full, pos)
    pos = apply_fit(pos, s, off, dz)
    hmpos = np.array(hm[sp][0])
    if cfg["fit"][0] != "back":
        # z placed as the hand-made animal's
        pos[:, 2] += (hmpos[:, 2].min() + hmpos[:, 2].max()) / 2 - (pos[:, 2].min() + pos[:, 2].max()) / 2
    if sp == VULTURE:
        hb = hmpos[np.abs(hmpos[:, 0]) < 0.1]
        body = pos[np.abs(pos[:, 0]) < 0.1]
        pos[:, 1] += np.median(hb[:, 1]) - np.median(body[:, 1])
    tris = outward(pos, tris)
    # posterise
    pal, lab = kmeans(vcol, varea, cfg["pal"])
    # toward the game's coat: the hide's mean colour is moved to fauna.ts's coat for the species
    # (fully for the goat, whose coats vary by animal; part way for the rest, keeping Tripo's hues)
    dom = (pal[lab] * varea[:, None]).sum(0) / varea.sum()
    gain = (np.array(SPEC_COAT[sp]) / np.maximum(dom, 0.02)) ** cfg.get("norm", 0.6)
    gain = np.minimum(gain, np.maximum(0.96 / np.maximum(pal.max(0), 1e-3), 1.0) if sp != GOAT else gain)  # no white burnt out
    pal = np.clip(pal * gain, 0.0, 1.0)
    print(f"NORM {name}: dominant {np.round(dom, 2)} -> gain {np.round(gain, 2)}")
    col = pal[lab]
    # nearest coat material (by the species' material colours)
    mats = material_colours(sp)
    amat = np.argmin(((col[:, None, :] - mats[None]) ** 2).sum(2), 1).astype(float)
    rigv, piv, region = rig(sp, cfg, pos, tris)
    nrm = vertex_normals(pos, tris)
    lo, hi = pos.min(0), pos.max(0)
    print(f"FIT {name}: scale {s:.3f}  x {lo[0]:.3f}..{hi[0]:.3f}  y {lo[1]:.3f}..{hi[1]:.3f}  z {lo[2]:.3f}..{hi[2]:.3f}  tris {len(tris)} verts {len(pos)}")
    print(f"PAL {name}: " + " ".join("(%.2f %.2f %.2f)" % tuple(c) for c in pal))
    return dict(sp=sp, pos=pos, nrm=nrm, tris=tris, col=col, amat=amat, rig=rigv, piv=piv, region=region)


def grouse_wings(m, hm):
    """Append fauna.py's sandgrouse wings (kind 5) to the converted body."""
    pos, nrm, rig_, piv, mp, tris = hm[GROUSE]
    keep = np.array([r[1] == 5 for r in rig_])
    remap = -np.ones(len(pos), int)
    remap[keep] = np.arange(keep.sum()) + len(m["pos"])
    wt = [t for t in tris if all(keep[i] for i in t)]
    mats = material_colours(GROUSE)
    wpos = np.array(pos)[keep]
    m["pos"] = np.vstack([m["pos"], wpos])
    m["nrm"] = np.vstack([m["nrm"], np.array(nrm)[keep]])
    m["rig"] = np.vstack([m["rig"], np.array(rig_)[keep]])
    m["piv"] = np.vstack([m["piv"], np.array(piv)[keep]])
    am = np.array([x[0] for x in mp])[keep]
    # the wing colours from the Tripo palette: the body colour nearest each wing material
    pal = np.unique(m["col"], axis=0)
    wc = []
    for a in am:
        target = mats[int(a)]
        wc.append(pal[np.argmin(((pal - target) ** 2).sum(1))])
    m["col"] = np.vstack([m["col"], np.array(wc)])
    m["amat"] = np.concatenate([m["amat"], am])
    m["tris"] = np.vstack([m["tris"], remap[np.array(wt)]])
    m["region"] = np.concatenate([m["region"], np.array(["wing"] * keep.sum(), dtype=object)])
    return m


# ---------------------------------------------------------------- export


def make_mesh(name, pos, nrm, tris):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(p) for p in pos], [], [tuple(int(i) for i in t) for t in tris])
    me.shade_smooth()
    me.normals_split_custom_set_from_vertices([to_blender(n) for n in nrm])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def set_attr(me, name, kind, values):
    a = me.attributes.new(name, kind, "POINT")
    prop = "value" if kind == "FLOAT" else "vector"
    a.data.foreach_set(prop, [float(c) for t in values for c in t])


def export(models, hm):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for sp in range(11):
        m = models.get(sp)
        if m is None:
            pos, nrm, rig_, piv, mp, tris = hm[sp]
            ob = make_mesh(NAMES[sp], pos, nrm, tris)
            me = ob.data
            set_attr(me, "_arig", "FLOAT2", [(r[0], r[1]) for r in rig_])
            set_attr(me, "_arigzw", "FLOAT2", [(r[2], r[3]) for r in rig_])
            set_attr(me, "_apivot", "FLOAT_VECTOR", piv)
            set_attr(me, "_amat", "FLOAT", [(x[0],) for x in mp])
            continue
        ob = make_mesh(NAMES[sp], m["pos"], m["nrm"], m["tris"])
        me = ob.data
        set_attr(me, "_arig", "FLOAT2", m["rig"][:, :2])
        set_attr(me, "_arigzw", "FLOAT2", m["rig"][:, 2:])
        set_attr(me, "_apivot", "FLOAT_VECTOR", m["piv"])
        set_attr(me, "_amat", "FLOAT", m["amat"][:, None])
        set_attr(me, "_acol", "FLOAT_VECTOR", m["col"])
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
    print("WROTE", OUT, os.path.getsize(OUT), "bytes")


# ---------------------------------------------------------------- the shader's poses, for previews


def rot_x(v, a):
    c, s = np.cos(a), np.sin(a)
    return np.stack([v[:, 0], v[:, 1] * c - v[:, 2] * s, v[:, 1] * s + v[:, 2] * c], 1)


def rot_y(v, a):
    c, s = np.cos(a), np.sin(a)
    return np.stack([v[:, 0] * c + v[:, 2] * s, v[:, 1], -v[:, 0] * s + v[:, 2] * c], 1)


def rot_z(v, a):
    c, s = np.cos(a), np.sin(a)
    return np.stack([v[:, 0] * c - v[:, 1] * s, v[:, 0] * s + v[:, 1] * c, v[:, 2]], 1)


def posed(sp, pos, rigv, piv, g=0.0, ph=0.0, pose=0.0):
    """fauna.ts's vertex shader (without the time-driven idle motions), on the rest mesh."""
    o, kind, z, w = rigv[:, 0], rigv[:, 1], rigv[:, 2], rigv[:, 3]
    fly = 0.0
    if sp == GROUSE:
        fly = min(1.0, max(0.0, g - 2.0))
        if g > 2.0:
            g = 0.0
    walk = min(g, 1.0)
    run = min(1.0, max(0.0, g - 1.0))
    p = pos.copy()
    q = p - piv
    th = TAU * (ph + o)
    leg = (kind > 0.5) & (kind < 1.5)
    amp = 0.45 + (0.85 - 0.45) * run
    if sp in (HARE, LIZARD):
        amp = 0.9
    elif sp == GROUSE:
        amp = 0.75
    elif sp == TORTOISE:
        amp = 0.5
    r = piv + rot_x(q, amp * walk * np.sin(th))
    p[leg] = r[leg]
    hd = ((kind > 1.5) & (kind < 2.5)) | ((kind > 3.5) & (kind < 4.5))
    pitch = (pose * 1.35 + 0.07 * walk * math.sin(2 * TAU * ph)) * z
    qq = q.copy()
    if sp == TORTOISE:
        qq[:, 2] -= 0.11 * pose
        pitch = 0.0 * z
    r = piv + rot_x(qq, pitch)
    p[hd] = r[hd]
    tl = (kind > 2.5) & (kind < 3.5)
    b = (0.35 * walk * np.sin(th) + run * 0.2) * z
    r = piv + rot_y(q, b)
    p[tl] = r[tl]
    wg = kind > 4.5
    if sp == GROUSE:
        flap = z * (fly * (0.95 * math.sin(TAU * ph) + 0.15) - 0.35 * (1 - fly))
        fold = z * 1.4 * (1 - fly)
        r = piv + rot_y(rot_z(q, flap), fold)
    else:
        r = piv + rot_z(q, z * (g * math.sin(TAU * ph) + 0.08))
    p[wg] = r[wg]
    if sp == LIZARD:
        p[:, 0] += np.sin(p[:, 2] * 26 - TAU * ph) * (0.004 + 0.012 * walk) * smoothstep(0.14, -0.1, p[:, 2])
    elif sp == SNAKE:
        wv = p[:, 2] * 15 - TAU * ph
        a = (0.035 + 0.02 * walk) * (1 + (0.35 - 1) * smoothstep(0.15, 0.3, p[:, 2]))
        p[:, 0] += np.sin(wv) * a
        p[:, 1] += 0.012 * walk * np.maximum(0, np.cos(wv))
    if sp == HARE:
        p[:, 1] += 0.1 * walk * (0.4 + run) * max(0.0, math.sin(TAU * ph))
    elif sp <= 1 or 5 <= sp <= 7 or sp == 10:
        k = 0.3 if sp == FOX else 0.15 if sp == GROUSE else 1.0
        p[~leg, 1] += (0.015 + 0.05 * run) * walk * math.sin(2 * TAU * ph) * k
    return p


# ---------------------------------------------------------------- previews

REGION_COL = {"body": (0.75, 0.72, 0.68), "leg": (0.85, 0.2, 0.15), "legband": (0.95, 0.65, 0.2), "neck": (0.2, 0.45, 0.9), "tail": (0.2, 0.75, 0.3), "wing": (0.7, 0.3, 0.8), "head": (0.2, 0.45, 0.9)}


def srgb_to_lin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def preview(models, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for sp, m in models.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        sc = bpy.context.scene
        sc.render.engine = "BLENDER_EEVEE"
        sc.render.resolution_x, sc.render.resolution_y = 900, 640
        sc.view_settings.view_transform = "Standard"
        world = bpy.data.worlds.new("w")
        world.use_nodes = True
        bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
        bg.inputs[0].default_value = (0.78, 0.66, 0.5, 1)
        bg.inputs[1].default_value = 0.6
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
        next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.5, 0.4, 0.28, 1)
        bpy.ops.mesh.primitive_plane_add(size=80)
        bpy.context.active_object.data.materials.append(sand)
        sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
        sun.data.energy = 4.0
        sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
        sc.collection.objects.link(sun)
        cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
        cam.data.type = "ORTHO"
        sc.collection.objects.link(cam)
        sc.camera = cam
        lift = 0.6 if sp == VULTURE else 0.0

        def build(p, cols, x_off=0.0):
            ob = make_mesh(f"{NAMES[sp]}_p", [(q[0] + x_off, q[1] + lift, q[2]) for q in p], m["nrm"], m["tris"])
            a = ob.data.attributes.new("col", "FLOAT_COLOR", "POINT")
            lin = srgb_to_lin(np.asarray(cols, float))
            a.data.foreach_set("color", [c for t in lin for c in (*t, 1.0)])
            ob.data.materials.append(mat)
            return ob

        def aim(target, eye):
            d = np.subtract(target, eye)
            cam.location = eye
            cam.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[0], -d[1]) + math.pi)

        def shoot(path):
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)

        pos = m["pos"]
        lo, hi = pos.min(0), pos.max(0)
        size = float(max(hi - lo))
        cy = (lo[1] + hi[1]) / 2 + lift
        cz = (lo[2] + hi[2]) / 2
        tag = f"{sp:02d}_{NAMES[sp]}"
        if grid_on:
            # a grid behind the side view, lines every step (thick ones every 5), for reading off joints
            step = 10 ** math.floor(math.log10(size / 4)) / 2 if size < 1 else 0.1
            gy0, gy1 = -step, hi[1] + step
            gz0, gz1 = lo[2] - step, hi[2] + step
            zs_ = [k * step for k in range(int(math.floor(gz0 / step)), int(math.ceil(gz1 / step)) + 1)]
            ys_ = [k * step for k in range(int(math.floor(gy0 / step)), int(math.ceil(gy1 / step)) + 1)]
            verts = [to_blender((1.0, y + lift, z)) for y in ys_ for z in zs_]
            nz = len(zs_)
            faces = [(i * nz + j, i * nz + j + 1, (i + 1) * nz + j + 1, (i + 1) * nz + j) for i in range(len(ys_) - 1) for j in range(nz - 1)]
            gm = bpy.data.meshes.new("grid")
            gm.from_pydata(verts, [], faces)
            go = bpy.data.objects.new("grid", gm)
            sc.collection.objects.link(go)
            wf = go.modifiers.new("wf", "WIREFRAME")
            wf.thickness = size * 0.003
            gmat = bpy.data.materials.new("gridm")
            gmat.use_nodes = True
            next(n for n in gmat.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.05, 0.05, 0.3, 1)
            gm.materials.append(gmat)
            print(f"GRID {NAMES[sp]}: step {step}")
        regc = np.array([REGION_COL[r] for r in m["region"]])
        # debug: a vertex's leg phase shown as a darker red for phase 0.5
        regc[(m["rig"][:, 1] == 1) & (m["rig"][:, 0] > 0.25)] *= 0.55
        for cols, suffix in ((m["col"], "col"), (regc, "rig")):
            ob = build(pos, cols)
            cam.data.ortho_scale = max(hi[2] - lo[2], (hi[1] - lo[1]) / 0.7, (hi[0] - lo[0]) * 0.8) * 1.15
            aim((0, -cz, cy), (-10, -cz, cy))
            shoot(os.path.join(out_dir, f"{tag}_{suffix}_side.png"))
            aim((0, -cz, cy), (7, -cz - 8, cy + 5))
            shoot(os.path.join(out_dir, f"{tag}_{suffix}_34.png"))
            if suffix == "rig":
                aim((0, -cz, cy), (0.001, -cz, cy + 10))
                shoot(os.path.join(out_dir, f"{tag}_{suffix}_top.png"))
            bpy.data.objects.remove(ob)
        if grid_on:
            bpy.data.objects.remove(go)
        # poses
        if sp == VULTURE:
            poses = [("flap_up", dict(g=0.5, ph=0.25)), ("flap_down", dict(g=0.5, ph=0.75))]
        elif sp == GROUSE:
            poses = [("ground", dict(g=0.0)), ("walk", dict(g=1.0, ph=0.25)), ("fly_up", dict(g=3.0, ph=0.25)), ("fly_down", dict(g=3.0, ph=0.75))]
        elif sp in (SNAKE, LIZARD):
            poses = [("move_a", dict(g=1.0, ph=0.0)), ("move_b", dict(g=1.0, ph=0.25)), ("run", dict(g=2.0, ph=0.6))]
        else:
            poses = [("stride", dict(g=1.0, ph=0.25)), ("graze", dict(pose=1.0)), ("run", dict(g=2.0, ph=0.25)), ("run_b", dict(g=2.0, ph=0.75))]
        for pname, kw in poses:
            p = posed(sp, pos, m["rig"], m["piv"], **kw)
            for cols, suffix in ((m["col"], "col"), (regc, "rig")):
                ob = build(p, cols)
                cam.data.ortho_scale = size * 1.25
                if sp in (SNAKE, LIZARD):
                    aim((0, -cz, cy), (0.001, -cz, cy + 10))
                else:
                    aim((0, -cz, cy), (-6, -cz - 6, cy + 3))
                shoot(os.path.join(out_dir, f"{tag}_pose_{pname}_{suffix}.png"))
                bpy.data.objects.remove(ob)
        files = [f"{tag}_col_side.png", f"{tag}_col_34.png", f"{tag}_rig_side.png", f"{tag}_rig_34.png", f"{tag}_rig_top.png"]
        files += [f"{tag}_pose_{pn}_{s}.png" for pn, _ in poses for s in ("col", "rig")]
        compose([os.path.join(out_dir, f) for f in files], os.path.join(out_dir, f"{tag}_sheet.png"), 3)


def compose(files, out, cols):
    """The renders tiled into one image, at half size."""
    ims = []
    for f in files:
        im = bpy.data.images.load(f)
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::2, ::2]
        ims.append(a)
        bpy.data.images.remove(im)
    H = max(i.shape[0] for i in ims)
    W = max(i.shape[1] for i in ims)
    rows = (len(ims) + cols - 1) // cols
    S = np.ones((rows * H, cols * W, 4), dtype=np.float32)
    for k, i in enumerate(ims):
        r, c = rows - 1 - k // cols, k % cols
        S[r * H : r * H + i.shape[0], c * W : c * W + i.shape[1]] = i
    o = bpy.data.images.new("sheet", cols * W, rows * H, alpha=True)
    o.pixels.foreach_set(S.ravel())
    o.filepath_raw = out
    o.file_format = "PNG"
    o.save()


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    only = None
    if "--only" in argv:
        only = [NAMES.index(n) for n in argv[argv.index("--only") + 1].split(",")]
    hm = handmade()
    models = {}
    for sp in range(11):
        if sp in KEEP or (only is not None and sp not in only):
            continue
        m = convert(sp, hm)
        if sp == GROUSE:
            m = grouse_wings(m, hm)
        models[sp] = m
    if only is None:
        export(models, hm)
        total = sum(len(m["tris"]) for m in models.values()) + sum(len(hm[sp][5]) for sp in KEEP)
        print("FAUNA total tris", total)
    if "--preview" in argv:
        global grid_on
        grid_on = "--grid" in argv
        preview(models, argv[argv.index("--preview") + 1])


grid_on = False
main()
