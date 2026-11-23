"""The Tripo fan palm (tools/tripo/source/palm_fan.glb) turned into the town palms of
public/art/props.glb, beside the shrubs and rocks of tools/blender/props.py.

    blender --background --python tools/tripo/palm_convert.py                    # write props.glb
    blender --background --python tools/tripo/palm_convert.py -- --preview DIR   # and render the palms

This script writes the whole props.glb: every model but the palms is built by props.py's own code
(so the shrubs, bushes, boulders and stones come out exactly as props.py makes them); the palms
are replaced by the fan palm, split three ways by colour and height:

  PalmTrunk      the trunk, from y -0.2 (buried) to the frond origin; the part below
                 TRUNK_TOP is what the game stretches to a tree's height, the boot above it is
                 kept as is (as props.py's)
  PalmCrown0..2  the green fans about the frond origin; three variants of the one crown (turned,
                 mirrored, scaled and tilted a little) so a grove doesn't look stamped
  PalmDead       the skirt of dry brown leaves under the crown, about the same origin
  (no PalmDates: fan palms carry none)

Sizes are those of props.py's reference tree (height 10: trunk top 9.5, frond origin 10.05).

Each vertex carries _info as props.py's (x material id, y tint 0..1, z sway 0..1) and _hue
(0..1): the colour, baked from Tripo's texture (averaged over each face of the decimated mesh,
posterised to a few colours per part and pulled toward the game's plant and wood colours), is
written as a (tint, hue) pair that the masonry shader (src/city/cityShaders.ts) turns back into
it: for plants and wood with a hue (aInfo.z > 0) the hue picks a colour between two ends and the
tint its value. The fit below uses the shader's exact formulas (PLANT_HUE, WOOD_HUE, *_K).
"""

import math
import os
import runpy
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

TAU = math.tau
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "source", "palm_fan.glb")
SRC_PNG = os.path.join(HERE, "source", "palm_fan.png")
OUT = os.path.join(ROOT, "public", "art", "props.glb")
PROPS_PY = os.path.join(ROOT, "tools", "blender", "props.py")

WOOD, PLANT = 3, 6
TRUNK_TOP = 9.5
FROND_Y = TRUNK_TOP + 0.55
BASE_Y = -0.2  # the trunk's foot, a little below the ground

# the conversion's knobs, in the source's frame (Blender z up, about 1 tall, foot at z -0.5)
SCALE = 16.0      # source units to metres for the crown, skirt and boot (spread ~0.45 x the tree)
GIRTH = 15.0      # and for the trunk's girth (the game scales it with the tree's height)
FLARE = 0.35      # the swollen foot: the trunk's girth there, over the source's own taper
RING_CUTS = 5     # extra rings cut round the trunk, so the bark banding has vertices to sit on
SRC_FOOT = -0.5
SRC_FROND = 0.02  # the source height taken for the frond origin
SRC_TOP = SRC_FROND - (FROND_Y - TRUNK_TOP) / SCALE  # where the stretched trunk ends
BUDGET = {"trunk": 240, "crown": 880, "skirt": 190}
PAL = {"trunk": 4, "crown": 6, "skirt": 4}
PULL = {"trunk": 0.45, "crown": 0.12, "skirt": 0.12}  # how far each part's mean colour moves toward the game's
TIPS = 0.22  # the crown's outer leaves lightened by up to this (fresh tips)

# the shader's baked colours (cityShaders.ts masonry, aInfo.z > 0); keep in step with it
PLANT_HUE = (np.array([0.5, 0.75, 0.12]), np.array([0.2, 0.55, 0.16]))
WOOD_HUE = (np.array([0.5, 0.42, 0.36]), np.array([0.7, 0.42, 0.2]))
PLANT_K = (0.6, 0.8)  # k = a + b * tint
WOOD_K = (0.7, 0.6)
# the game's own colours the parts are pulled toward (the albedo before the light)
GAME_PLANT = np.array([0.46, 0.6, 0.3]) * 1.08
GAME_WOOD = np.array([0.52, 0.42, 0.34])  # a little greyer than the game's timber, as Tripo's bark
GAME_STRAW = np.array([0.6, 0.48, 0.36])
# the trunk's tint as the game writes it: bark + (tint - 0.38) * 200, bark 70..140
BARK_MEAN = 105


def to_game(co):
    return (co[0], co[2], -co[1])


def to_blender(p):
    return (p[0], -p[2], p[1])


# ---------------------------------------------------------------- import


def load():
    """The welded, triangulated source: positions (source frame, z up), triangles, corner uvs and
    the texture."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
    obs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    img = next(n.image for o in obs for m in o.data.materials if m and m.node_tree for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)
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
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    uvl = me.uv_layers.active.data
    pos = np.array([tuple(v.co) for v in me.vertices])
    tri = np.array([[me.loops[li].vertex_index for li in p.loop_indices] for p in me.polygons])
    uv = np.array([[tuple(uvl[li].uv) for li in p.loop_indices] for p in me.polygons])
    w, h = img.size
    tex = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[:, :, :3]
    print(f"SOURCE {len(pos)} verts {len(tri)} tris, texture {w}x{h}")
    return pos, tri, uv, tex


def tex_at(tex, uv):
    h, w = tex.shape[:2]
    x = int(min(w - 1, max(0, (uv[0] % 1.0) * w)))
    y = int(min(h - 1, max(0, (uv[1] % 1.0) * h)))
    return tex[y, x]


def face_colours(pos, tri, uv, tex):
    bary = [(1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)]
    out = np.zeros((len(tri), 3))
    for f in range(len(tri)):
        out[f] = np.mean([tex_at(tex, a * uv[f][0] + b * uv[f][1] + c * uv[f][2]) for a, b, c in bary], 0)
    return out


def split(pos, tri, fcol):
    """Each face's part: trunk below the crown, then green (crown) or brown (skirt) by colour,
    tidied over the mesh's connectivity (a face takes its neighbours' part when it is alone)."""
    cen = pos[tri].mean(1)
    r, g, b = fcol[:, 0], fcol[:, 1], fcol[:, 2]
    green = (g > r * 1.08) & (g > b * 1.5)
    part = np.where(green, 1, 2)
    rad = np.hypot(cen[:, 0], cen[:, 1])
    part[(cen[:, 2] < SRC_FROND - 0.03) & (rad < 0.07) & ~green] = 0
    # neighbours by shared edge
    edges = {}
    for f, t in enumerate(tri):
        for k in range(3):
            e = tuple(sorted((t[k], t[(k + 1) % 3])))
            edges.setdefault(e, []).append(f)
    nb = [[] for _ in tri]
    for fs in edges.values():
        for a in fs:
            for c in fs:
                if a != c:
                    nb[a].append(c)
    for _ in range(2):
        new = part.copy()
        for f in range(len(tri)):
            if part[f] == 0 or not nb[f]:
                continue
            vals = [part[c] for c in nb[f] if part[c] != 0]
            if vals and all(v != part[f] for v in vals):
                new[f] = max(set(vals), key=vals.count)
        part = new
    print("SPLIT trunk %d crown %d skirt %d" % tuple((part == k).sum() for k in range(3)))
    return part


# ---------------------------------------------------------------- one sheet, then decimate


def one_sided(pos, ft, centre, up):
    """Tripo's leaves are thin closed slabs (a top and a bottom sheet a few centimetres apart);
    the game draws plants two-sided, so one sheet is enough. A face with a face of the opposite
    facing just behind it keeps only if it looks out from `centre` (leaning `up`), so each pair
    keeps one; the slivers round the rims go with the backs."""
    bvh = BVHTree.FromPolygons([Vector(v) for v in pos], [tuple(int(i) for i in t) for t in ft])
    keep = np.ones(len(ft), bool)
    C = Vector(centre)
    for f, t in enumerate(ft):
        a, b, c = (Vector(pos[i]) for i in t)
        n = (b - a).cross(c - a)
        if n.length < 1e-12:
            keep[f] = False
            continue
        n.normalize()
        cen = (a + b + c) / 3
        _, nn, _, d = bvh.ray_cast(cen - n * 1e-5, -n, 0.012)
        if d is None or nn is None or n.dot(nn) > -0.5:
            # no sheet behind: a rim sliver (narrow) or a lone face
            e = sorted([(b - a).length, (c - b).length, (a - c).length])
            keep[f] = n.length > 0 and (b - a).cross(c - a).length / max(e[2], 1e-9) > 0.004
            continue
        out = (cen - C)
        out.z = 0
        out = out.normalized() if out.length > 1e-9 else Vector((0, 0, 0))
        keep[f] = n.dot(out + Vector((0, 0, up))) >= 0
    print(f"ONE SIDED: {len(ft)} -> {keep.sum()} faces")
    return keep


def decimate(pos, tri, budget, name):
    """The faces' own mesh, collapsed to the budget; positions (source frame) and triangles."""
    used = np.unique(tri)
    remap = -np.ones(len(pos), int)
    remap[used] = np.arange(len(used))
    p = pos[used]
    t = remap[tri]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in p], [], [tuple(int(i) for i in f) for f in t])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if len(t) > budget:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = budget / len(t) * 0.99
        mod.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    em = ob.evaluated_get(dg).to_mesh()
    dp = np.array([tuple(v.co) for v in em.vertices])
    dt = np.array([list(f.vertices) for f in em.polygons])
    ob.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(ob)
    print(f"DECIMATE {name}: {len(t)} -> {len(dt)} tris, {len(dp)} verts")
    return dp, dt


def ring_cuts(pos, ft, n):
    """The trunk's faces with n level rings cut in between the foot and the stretched top."""
    bm = bmesh.new()
    used = np.unique(ft)
    vs = {int(i): bm.verts.new(tuple(pos[i])) for i in used}
    for t in ft:
        try:
            bm.faces.new([vs[int(i)] for i in t])
        except ValueError:
            pass
    for z in np.linspace(SRC_FOOT + 0.04, SRC_TOP - 0.02, n):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, float(z)), plane_no=(0, 0, 1))
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.index_update()
    dp = np.array([tuple(v.co) for v in bm.verts])
    dt = np.array([[v.index for v in f.verts] for f in bm.faces])
    bm.free()
    print(f"RING CUTS trunk: {len(ft)} -> {len(dt)} tris, {len(dp)} verts")
    return dp, dt


def sampler(pos, tri, uv, tex):
    """The texture at the nearest point of the given (full-resolution) faces."""
    bvh = BVHTree.FromPolygons([Vector(v) for v in pos], [tuple(int(i) for i in t) for t in tri])

    def at(q):
        loc, _, fi, _ = bvh.find_nearest(Vector(q))
        if fi is None:
            return None
        t = tri[fi]
        u = barycentric_transform(loc, *(Vector(pos[i]) for i in t), *(Vector((*uv[fi][k], 0)) for k in range(3)))
        return tex_at(tex, u)

    return at


def vertex_colours(at, pos, tri):
    bary = [(1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)]
    acc = np.zeros((len(pos), 3))
    wsum = np.zeros(len(pos))
    for t in tri:
        a, b, c = pos[t[0]], pos[t[1]], pos[t[2]]
        cs = [at(a * x + b * y + c * z) for x, y, z in bary]
        cs = [x for x in cs if x is not None]
        col = np.mean(cs, 0) if cs else np.array([0.5, 0.5, 0.5])
        area = 0.5 * np.linalg.norm(np.cross(b - a, c - a)) + 1e-12
        for i in t:
            acc[i] += col * area
            wsum[i] += area
    return acc / np.maximum(wsum, 1e-12)[:, None], wsum


def kmeans(x, wt, k, iters=40):
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
    lab = np.argmin(((x[:, None, :] - cent[None]) ** 2).sum(2), 1)
    return cent, lab


# ---------------------------------------------------------------- colour as the shader makes it


def shader_albedo(mat, tint, hue):
    """The lit albedo (before uLit) the masonry shader gives a baked vertex: tint as the game
    writes it (0..1), hue 0..1 (the seed byte / 255)."""
    ends, (a, b) = (PLANT_HUE, PLANT_K) if mat == PLANT else (WOOD_HUE, WOOD_K)
    return (ends[0] + (ends[1] - ends[0]) * hue) * (a + b * tint)


def fit(mat, c):
    """The (game tint 0..1, hue byte 1..255) whose shader colour is nearest c."""
    ends, (a, b) = (PLANT_HUE, PLANT_K) if mat == PLANT else (WOOD_HUE, WOOD_K)
    best = None
    for byte in range(1, 256):
        h = ends[0] + (ends[1] - ends[0]) * (byte / 255)
        k = float(np.dot(c, h) / np.dot(h, h))
        t = min(1.0, max(0.0, (k - a) / b))
        e = float(np.sum((c - h * (a + b * t)) ** 2))
        if best is None or e < best[0]:
            best = (e, t, byte)
    return best[1], best[2]


def colour_part(name, mat, vcol, area, target):
    """Posterise to the part's palette, pull its mean toward the game's colour and fit each colour
    to the shader's (tint, hue). Returns per-vertex game tint (0..1) and hue byte, and the palette."""
    pal, lab = kmeans(vcol, area, PAL[name])
    dom = (pal[lab] * area[:, None]).sum(0) / area.sum()
    gain = (target / np.maximum(dom, 0.02)) ** PULL[name]
    pal2 = np.clip(pal * gain, 0.0, 1.0)
    fits = [fit(mat, c) for c in pal2]
    print(f"PAL {name}: mean {np.round(dom, 2)} gain {np.round(gain, 2)}")
    for c0, c1, (t, hb) in zip(pal, pal2, fits):
        print(f"   {np.round(c0, 2)} -> {np.round(c1, 2)} -> tint {t:.2f} hue {hb} = {np.round(shader_albedo(mat, t, hb / 255), 2)}")
    tint = np.array([fits[l][0] for l in lab])
    hue = np.array([fits[l][1] for l in lab])
    return tint, hue


# ---------------------------------------------------------------- the parts


def axis(pos_t):
    """The trunk's centre line: (x, y) at the foot and the top, in the source frame."""
    lo = pos_t[pos_t[:, 2] < SRC_FOOT + 0.08]
    hi = pos_t[(pos_t[:, 2] > SRC_TOP - 0.12) & (pos_t[:, 2] < SRC_TOP)]
    return lo[:, :2].mean(0), hi[:, :2].mean(0)


def trunk_to_game(p, c0, c1):
    """Source trunk points to the game frame: straightened onto the axis, the shaft stretched from
    the foot to TRUNK_TOP, the boot above at SCALE."""
    z = p[:, 2]
    t = np.clip((z - SRC_FOOT) / (SRC_TOP - SRC_FOOT), 0, 1)[:, None]
    ctr = c0 + (c1 - c0) * t
    foot = 1 - np.clip((z - SRC_FOOT) / 0.07, 0, 1)
    xy = (p[:, :2] - ctr) * GIRTH * (1 + FLARE * (foot * foot * (3 - 2 * foot)))[:, None]
    y = np.where(z <= SRC_TOP, BASE_Y + (z - SRC_FOOT) / (SRC_TOP - SRC_FOOT) * (TRUNK_TOP - BASE_Y), TRUNK_TOP + (z - SRC_TOP) * SCALE)
    return np.stack([xy[:, 0], y, -xy[:, 1]], 1)


def crown_to_game(p, c1):
    q = (p - np.array([c1[0], c1[1], SRC_FROND])) * SCALE
    return np.stack([q[:, 0], q[:, 2], -q[:, 1]], 1)


def variant(pos, tri, i):
    """Crown variant i: turned, mirrored, scaled and tilted a little about the frond origin."""
    turn, mirror, sh, sv, tilt, tdir = [(0.0, False, 1.0, 1.0, 0.0, 0.0), (2.2, True, 0.94, 1.03, 0.07, 0.8), (4.1, False, 1.06, 0.93, 0.06, 3.6)][i]
    p = pos.copy()
    t = tri.copy()
    if mirror:
        p[:, 0] *= -1
        t = t[:, [0, 2, 1]]
    c, s = math.cos(turn), math.sin(turn)
    x, z = p[:, 0] * c - p[:, 2] * s, p[:, 0] * s + p[:, 2] * c
    p = np.stack([x * sh, p[:, 1] * sv, z * sh], 1)
    if tilt:
        ax = np.array([math.cos(tdir), 0, math.sin(tdir)])
        R = np.array(Matrix.Rotation(tilt, 3, Vector(ax)))
        p = p @ R.T
    return p, t


def build():
    pos, tri, uv, tex = load()
    fcol = face_colours(pos, tri, uv, tex)
    part = split(pos, tri, fcol)
    c0, c1 = axis(pos[np.unique(tri[part == 0])])
    out = {}
    stats = {}
    for k, name in enumerate(("trunk", "crown", "skirt")):
        ft = tri[part == k]
        if name != "trunk":
            fp = pos[np.unique(ft)]
            centre = fp.mean(0) if name == "crown" else np.array([c1[0], c1[1], SRC_FROND])
            ft = ft[one_sided(pos, ft, centre, 0.6 if name == "crown" else 0.0)]
        if name == "trunk":
            dp, dt = ring_cuts(pos, ft, RING_CUTS)
        else:
            dp, dt = decimate(pos, ft, BUDGET[name], name)
        at = sampler(pos, tri[part == k], uv[part == k], tex)
        vcol, area = vertex_colours(at, dp, dt)
        if name == "trunk":
            # the bands: the texture right at each vertex counts as much as the faces round it
            vcol = 0.5 * vcol + 0.5 * np.array([at(p) for p in dp])
            # and are drawn out a little, so they survive the posterising
            m = (vcol * area[:, None]).sum(0) / area.sum()
            vcol = np.clip(m + 1.7 * (vcol - m), 0, 1)
        if name == "crown":
            d = np.linalg.norm(crown_to_game(dp, c1), axis=1)
            u = np.clip((d / np.percentile(d, 98) - 0.55) / 0.45, 0, 1)
            vcol = np.clip(vcol * (1 + TIPS * u * u * (3 - 2 * u))[:, None], 0, 1)
        mat = PLANT if name == "crown" else WOOD
        target = {"crown": GAME_PLANT, "trunk": GAME_WOOD, "skirt": GAME_STRAW}[name]
        tint, hue = colour_part(name, mat, vcol, area, target)
        if name == "trunk":
            g = trunk_to_game(dp, c0, c1)
            # the game writes bark + (tint - 0.38) * 200: the fit is for a tree of the mean bark
            tint = 0.38 + (tint * 255 - BARK_MEAN) / 200
            sway = np.clip(g[:, 1] / TRUNK_TOP, 0, 1)
        else:
            g = crown_to_game(dp, c1)
            d = np.linalg.norm(g, axis=1)
            if name == "crown":
                sway = np.clip(d / np.percentile(d, 98), 0, 1) ** 1.2
            else:
                sway = 0.3 * np.clip(d / d.max(), 0, 1)
        info = np.stack([np.full(len(g), mat, float), tint, sway], 1)
        stats[name] = (len(dt), g.min(0), g.max(0))
        out[name] = (g, dt, info, hue / 255.0)
    for name, (n, lo, hi) in stats.items():
        print(f"PART {name}: {n} tris  x {lo[0]:.2f}..{hi[0]:.2f}  y {lo[1]:.2f}..{hi[1]:.2f}  z {lo[2]:.2f}..{hi[2]:.2f}")
    g, dt, info, hue = out["crown"]
    r = np.hypot(g[:, 0], g[:, 2])
    for f in (0.5, 0.7, 0.85):
        m = r > f * np.percentile(r, 98)
        print(f"CROWN lowest beyond {f:.2f} of the radius: {g[m, 1].min():.2f}")
    print(f"CROWN radius {r.max():.2f} (98%: {np.percentile(r, 98):.2f}), lowest {g[:, 1].min():.2f}; SKIRT lowest {out['skirt'][0][:, 1].min():.2f}")
    palms = {"PalmTrunk": out["trunk"]}
    for i in range(3):
        p, t = variant(out["crown"][0], out["crown"][1], i)
        palms[f"PalmCrown{i}"] = (p, t, out["crown"][2], out["crown"][3])
    palms["PalmDead"] = out["skirt"]
    return palms


# ---------------------------------------------------------------- export


def props_models():
    """props.py's models but the palms (props.py runs nothing when loaded this way)."""
    ns = runpy.run_path(PROPS_PY, run_name="props_lib")
    ms = ns["models"]()
    for n in [n for n in ms if n.startswith("Palm")]:
        del ms[n]
    return ns, ms


def export(palms, ns, ms):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, (g, t, info, hue) in palms.items():
        me = bpy.data.meshes.new(name)
        me.from_pydata([to_blender(p) for p in g], [], [tuple(int(i) for i in f) for f in t])
        me.validate(clean_customdata=False)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        a = me.attributes.new("_info", "FLOAT_VECTOR", "POINT")
        a.data.foreach_set("vector", info.astype(np.float32).ravel().tolist())
        a = me.attributes.new("_hue", "FLOAT", "POINT")
        a.data.foreach_set("value", hue.astype(np.float32).tolist())
    for name, m in ms.items():
        ob = ns["make_mesh"](name, m)
        me = ob.data
        if len(m.attr[0]) == 1:
            a = me.attributes.new("_shade", "FLOAT", "POINT")
            a.data.foreach_set("value", [t[0] for t in m.attr])
        else:
            a = me.attributes.new("_info", "FLOAT_VECTOR", "POINT")
            a.data.foreach_set("vector", [c for t in m.attr for c in t])
    before = os.path.getsize(OUT) if os.path.exists(OUT) else 0
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
    print(f"PROPS {OUT}: {before} -> {os.path.getsize(OUT)} bytes")


# ---------------------------------------------------------------- previews

# the game's daylight (daycycle.ts FILM_KEYS, the day key's lit and shade)
U_LIT = np.array([0xD9, 0xA0, 0x4E]) / 255
U_SHADE = np.array([0x6E, 0x4A, 0x24]) / 255
SH_RATIO = {PLANT: np.array([0.913, 0.867, 1.133]), WOOD: np.array([1.06, 1.125, 1.226])}


def srgb_to_lin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def tree_parts(palms, h, crown, seed, dead=True):
    """One palm of height h as modelledTree() places it (no lean): positions, triangles, lit and
    shade colours."""
    rng = np.random.default_rng(seed)
    top = h - 0.5
    kr = h / 10
    cs = (0.95 + 0.11 * h) / (0.95 + 0.11 * 10)
    yaw = rng.random() * TAU
    bark = 70 + int(rng.random() * 70)
    green = round((rng.random() - 0.5) * 50)
    dh = round((rng.random() - 0.5) * 60)  # the crown's hue shift (plants.ts modelledTree)
    c, s = math.cos(yaw), math.sin(yaw)
    parts = []
    names = ["PalmTrunk", f"PalmCrown{crown}"] + (["PalmDead"] if dead else [])
    for n in names:
        g, t, info, hue = palms[n]
        g = g.copy()
        mat = int(info[0, 0])
        if n == "PalmTrunk":
            y = g[:, 1]
            g[:, 1] = np.where(y < 0, y, np.where(y <= TRUNK_TOP, y * top / TRUNK_TOP, top + (y - TRUNK_TOP)))
            g[:, 0] *= kr
            g[:, 2] *= kr
            tint = np.clip(np.round(bark + (info[:, 1] - 0.38) * 200), 0, 255) / 255
        else:
            g = g * cs
            g[:, 1] += top + (FROND_Y - TRUNK_TOP)
            tint = np.clip(np.round(info[:, 1] * 255 + (green if mat == PLANT else 0)), 0, 255) / 255
        x, z = g[:, 0] * c - g[:, 2] * s, g[:, 0] * s + g[:, 2] * c
        g = np.stack([x, g[:, 1], z], 1)
        if mat == PLANT:
            hue = np.clip(np.round(hue * 255) + dh, 1, 255) / 255
        alb = np.array([shader_albedo(mat, tt, hh) for tt, hh in zip(tint, hue)])
        li = alb * U_LIT
        sh = alb * SH_RATIO[mat] * U_SHADE
        parts.append((g, t, li, sh, mat == PLANT))
    return parts


def preview(palms, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (*srgb_to_lin(np.array([0.86, 0.78, 0.64])), 1)
    bg.inputs[1].default_value = 1.0
    sc.world = world

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(48), 0, math.radians(-35))
    sc.collection.objects.link(sun)

    # the game's light: n.l soft-wrapped (smoothstep -0.12..0.5) and banded, mixing the shade and
    # lit colours; back faces turned round, as the two-sided plants are
    from mathutils import Euler
    sdir = Euler(sun.rotation_euler).to_matrix() @ Vector((0, 0, 1))
    mat = bpy.data.materials.new("toon")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    outn = nt.nodes.new("ShaderNodeOutputMaterial")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    flip = nt.nodes.new("ShaderNodeMath")
    flip.operation = "MULTIPLY_ADD"
    flip.inputs[1].default_value = -2.0
    flip.inputs[2].default_value = 1.0
    nt.links.new(geo.outputs["Backfacing"], flip.inputs[0])
    nflip = nt.nodes.new("ShaderNodeVectorMath")
    nflip.operation = "SCALE"
    nt.links.new(geo.outputs["Normal"], nflip.inputs[0])
    nt.links.new(flip.outputs[0], nflip.inputs["Scale"])
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = tuple(sdir)
    nt.links.new(nflip.outputs[0], dot.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = -0.12
    mr.inputs["From Max"].default_value = 0.5
    nt.links.new(dot.outputs["Value"], mr.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0, 0, 0, 1)
    els[1].position, els[1].color = 0.25, (0.33, 0.33, 0.33, 1)
    e = els.new(0.55)
    e.color = (0.7, 0.7, 0.7, 1)
    e = els.new(0.85)
    e.color = (1, 1, 1, 1)
    # sun through the leaves: the far side glows a little (0.3, as the masonry shader's plants)
    neg = nt.nodes.new("ShaderNodeMath")
    neg.operation = "MULTIPLY"
    neg.inputs[1].default_value = -1.0
    nt.links.new(dot.outputs["Value"], neg.inputs[0])
    mr2 = nt.nodes.new("ShaderNodeMapRange")
    mr2.interpolation_type = "SMOOTHSTEP"
    mr2.inputs["From Min"].default_value = -0.05
    mr2.inputs["From Max"].default_value = 0.5
    mr2.inputs["To Max"].default_value = 0.3
    nt.links.new(neg.outputs[0], mr2.inputs["Value"])
    leafa = nt.nodes.new("ShaderNodeAttribute")
    leafa.attribute_name = "leaf"
    tl = nt.nodes.new("ShaderNodeMath")
    tl.operation = "MULTIPLY"
    nt.links.new(mr2.outputs[0], tl.inputs[0])
    nt.links.new(leafa.outputs["Fac"], tl.inputs[1])
    mx = nt.nodes.new("ShaderNodeMath")
    mx.operation = "MAXIMUM"
    nt.links.new(mr.outputs[0], mx.inputs[0])
    nt.links.new(tl.outputs[0], mx.inputs[1])
    nt.links.new(mx.outputs[0], ramp.inputs[0])
    li = nt.nodes.new("ShaderNodeAttribute")
    li.attribute_name = "li"
    sh = nt.nodes.new("ShaderNodeAttribute")
    sh.attribute_name = "sh"
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(ramp.outputs["Color"], mix.inputs["Factor"])
    nt.links.new(sh.outputs["Color"], mix.inputs[6])
    nt.links.new(li.outputs["Color"], mix.inputs[7])
    nt.links.new(mix.outputs[2], em.inputs[0])
    nt.links.new(em.outputs[0], outn.inputs[0])
    mat.use_backface_culling = False

    sand = bpy.data.materials.new("sand")
    sand.use_nodes = True
    next(n for n in sand.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (*srgb_to_lin(np.array([0.8, 0.66, 0.48])), 1)
    bpy.ops.mesh.primitive_plane_add(size=400)
    bpy.context.active_object.data.materials.append(sand)

    def add(name, g, t, lic, shc, x, leaf):
        me = bpy.data.meshes.new(name)
        me.from_pydata([to_blender(p + np.array([x, 0, 0])) for p in g], [], [tuple(int(i) for i in f) for f in t])
        a = me.attributes.new("leaf", "FLOAT", "POINT")
        a.data.foreach_set("value", [1.0 if leaf else 0.0] * len(g))
        for nm, cc in (("li", lic), ("sh", shc)):
            a = me.attributes.new(nm, "FLOAT_COLOR", "POINT")
            a.data.foreach_set("color", [v for c in srgb_to_lin(cc) for v in (*c, 1.0)])
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        return ob

    # the row: three heights, three crowns
    for i, (x, h) in enumerate([(-7.0, 7.0), (0.0, 10.0), (7.0, 13.0)]):
        for k, (g, t, lic, shc, leaf) in enumerate(tree_parts(palms, h, i, 11 + i)):
            add(f"p{i}_{k}", g, t, lic, shc, x, leaf)

    # the Tripo source beside, scaled to the 10 m tree's total height, as Tripo textured it
    bpy.ops.import_scene.gltf(filepath=SRC)
    src = [o for o in sc.objects if o.type == "MESH" and o.name.startswith("tripo")]
    for o in src:
        dims = o.dimensions
        o.scale = (1, 1, 1)
        hh = 13.05 + float(palms["PalmCrown2"][0][:, 1].max()) * (0.95 + 0.11 * 13) / (0.95 + 0.11 * 10)  # the converted 13 m palm's top
        k = hh / dims[2]
        o.scale = (k, k, k)
        o.location = (14.0, 0, 0.5 * k)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam

    def shoot(path, loc, look, lens=35):
        cam.location = loc
        d = Vector(look) - Vector(loc)
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    shoot(os.path.join(out_dir, "street.png"), (3, -26, 1.7), (3, 0, 7.5), 24)
    shoot(os.path.join(out_dir, "three_quarter.png"), (24, -30, 22), (3, 0, 8), 30)
    shoot(os.path.join(out_dir, "compare.png"), (10.5, -34, 9), (10.5, 0, 10), 35)
    shoot(os.path.join(out_dir, "compare_crowns.png"), (10.5, -17, 15), (10.5, 0, 15), 35)
    shoot(os.path.join(out_dir, "crowns_close.png"), (0, -12, 16), (0, 0, 11.5), 40)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    palms = build()
    for n, (g, t, info, hue) in palms.items():
        print("PALM", n, "verts", len(g), "tris", len(t))
    if "--no-export" not in argv:
        ns, ms = props_models()
        export(palms, ns, ms)
    if "--preview" in argv:
        preview(palms, argv[argv.index("--preview") + 1])


main()
