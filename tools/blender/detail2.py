"""Bake public/art/detail2.png: tileable 512x512 surface detail for the world's own surfaces.
R wind-sorted sand grain, G sedimentary rock (bedding runs along U, so rows are layers),
B wood grain (fibres run along U). Each channel is mid-grey 0.5 on average (the shader reads
texel - 0.5). All maths is periodic, so it tiles in both axes.
Run: blender --background --python tools/blender/detail2.py"""
import os
import bpy
import numpy as np

N = 512
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "art", "detail2.png")
fx = np.fft.fftfreq(N)[None, :] * N
fy = np.fft.fftfreq(N)[:, None] * N
RAD = np.sqrt(fx * fx + fy * fy)
U, V = np.meshgrid(np.arange(N) / N, np.arange(N) / N)  # U along x (columns), V along y (rows)


def band_noise(lo, hi, aniso=(1.0, 1.0), seed=0):
    """Periodic noise band-limited to radial frequencies lo..hi (cycles per tile), unit std.
    aniso scales the x / y frequency axes: a large x factor stretches features along x."""
    w = np.random.default_rng(seed).standard_normal((N, N))
    rr = np.sqrt((fx * aniso[0]) ** 2 + (fy * aniso[1]) ** 2)
    f = np.exp(-((rr - 0.5 * (lo + hi)) / max(0.5 * (hi - lo), 1e-3)) ** 2)
    a = np.real(np.fft.ifft2(np.fft.fft2(w) * f))
    return a / a.std()


def blur(a, cut):
    return np.real(np.fft.ifft2(np.fft.fft2(a) * np.exp(-(RAD / cut) ** 2)))


def norm(a, std):
    a = a - a.mean()
    return a / a.std() * std


def sample_rows(profile, v):
    """profile[k] over N rows, read at periodic row coordinate v (0..1), linear interpolation."""
    p = (v % 1.0) * N
    i = np.floor(p).astype(int)
    f = p - i
    return profile[i % N] * (1 - f) + profile[(i + 1) % N] * f


# ---- R: sand. Per-pixel grain, a few dark mineral and bright quartz grains, faint streaks
# along x (wind-sorted), all at grain scale: nothing below ~16 cycles per tile.
grain = band_noise(60, 150, seed=1)
clump = band_noise(30, 80, seed=2)
streak = band_noise(14, 50, aniso=(7.0, 1.0), seed=3)  # long along x, thin across
rs = np.random.default_rng(4)
spots = np.zeros((N, N))
for sgn, count in ((-1.0, 2600), (1.0, 1800)):
    ys, xs = rs.integers(0, N, count), rs.integers(0, N, count)
    spots[ys, xs] += sgn * rs.uniform(0.6, 1.0, count)
spots = blur(spots, 110)
spots /= spots.std()
sand = 0.45 * grain + 0.3 * clump + 0.38 * streak + 0.6 * spots
sand = norm(sand, 0.11)

# ---- G: rock. Horizontal strata of uneven thickness, gently warped, with joints that cross
# one bed and stop at its edges, pitting, and fine grain.
rr = np.random.default_rng(11)
L = 11
th = rr.uniform(0.4, 1.6, L)
edges = np.concatenate([[0.0], np.cumsum(th) / th.sum()])
tone = rr.normal(0.0, 1.0, L)
rows = np.arange(N) / N
layer = np.searchsorted(edges, rows, side="right") - 1
layer = np.clip(layer, 0, L - 1)
pos = (rows - edges[layer]) / (edges[layer + 1] - edges[layer])  # 0..1 within a bed
prof = tone[layer] * 0.8 + 0.5 * np.sin(np.pi * pos) - 1.2 * np.exp(-(pos / 0.08) ** 2)  # dark parting line
prof += 0.25 * np.sin(rows * 2 * np.pi * 37) * rr.uniform(0.4, 1.0)  # fine laminae
warp = band_noise(1, 4, seed=12) * 0.012 + band_noise(5, 14, seed=13) * 0.003
vv = V + warp
strata = sample_rows(prof, vv)
bed = np.clip(np.searchsorted(edges, vv % 1.0, side="right") - 1, 0, L - 1)
# joints: near-vertical lines, a few per bed, kept inside the bed
joints = np.zeros((N, N))
for b in range(L):
    for _ in range(int(rr.integers(1, 4))):
        x0 = rr.uniform(0, 1)
        lean = rr.normal(0, 0.06)
        d = ((U - x0 - lean * (vv % 1.0) + 0.5) % 1.0) - 0.5
        joints += np.where(bed == b, np.exp(-(d / 0.0028) ** 2), 0.0)
joints = np.clip(joints, 0, 1) * (0.6 + 0.4 * (band_noise(4, 16, seed=14) > -0.3))
pits = np.maximum(band_noise(50, 120, seed=15) - 1.2, 0)
pits = pits / pits.max()
rock = 0.9 * strata + 0.35 * band_noise(30, 90, aniso=(2.5, 1.0), seed=16) + 0.22 * band_noise(60, 140, seed=17)
rock = norm(rock, 1.0) - 2.2 * joints - 2.0 * pits
rock = norm(rock, 0.10)

# ---- B: wood. Fibres along x, growth-line figure warped by slow noise, a few knots that the
# figure flows around.
rw = np.random.default_rng(21)
ux, vy = U.copy(), V.copy()
defl = np.zeros((N, N))
knot_mask = np.zeros((N, N))
for _ in range(3):
    kx, ky = rw.uniform(0, 1, 2)
    rad = rw.uniform(0.018, 0.032)
    dx = ((U - kx + 0.5) % 1.0) - 0.5
    dy = ((V - ky + 0.5) % 1.0) - 0.5
    r = np.sqrt((dx / 2.2) ** 2 + dy ** 2)  # knots are drawn out a little along the grain
    defl += np.sign(dy) * rad * 0.9 * np.exp(-(r / (rad * 2.2)) ** 2)
    knot_mask += np.exp(-(r / rad) ** 4)
    ring = np.sin(r / rad * 7.0) * np.exp(-(r / (rad * 1.6)) ** 2)
    knot_mask += 0.25 * ring
fig_v = vy + 0.006 * band_noise(1, 3, aniso=(2.0, 1.0), seed=22) + 0.004 * band_noise(4, 10, aniso=(3.0, 1.0), seed=26) + defl
# growth lines of uneven spacing and strength: a periodic phase with a slow wobble in its rate
phase = fig_v * 18.0 + 0.35 * np.sin(2 * np.pi * fig_v * 3.0) + 0.2 * np.sin(2 * np.pi * fig_v * 7.0 + 1.3)
lines = np.exp(-((np.mod(phase, 1.0) - 0.5) / 0.12) ** 2)
lines *= 0.6 + 0.4 * band_noise(2, 8, aniso=(4.0, 1.0), seed=27)
fibre = band_noise(30, 110, aniso=(12.0, 1.0), seed=23)  # very long along x
pores = band_noise(60, 140, aniso=(5.0, 1.0), seed=24)
wood = -1.5 * lines + 0.6 * fibre + 0.25 * pores + 0.12 * band_noise(3, 10, aniso=(4.0, 1.0), seed=25)
wood = norm(wood, 1.0) - 2.4 * np.clip(knot_mask, 0, 1.2)
wood = norm(wood, 0.10)

out = np.zeros((N, N, 3))
for i, c in enumerate((sand, rock, wood)):
    c = np.clip(c + 0.5, 0, 1)
    c = c - c.mean() + 0.5
    q = (8, 6, 6)[i]  # coarse levels: invisible at the shader's gain, keeps the PNG small
    c = np.round(c * 255 / q) * q / 255
    out[..., i] = np.clip(c, 0, 1)

rgba = np.ones((N, N, 4), dtype=np.float32)
rgba[..., :3] = out
rgba = rgba[::-1]  # Blender rows run bottom-up
img = bpy.data.images.new("detail2", N, N, alpha=False, float_buffer=False)
img.colorspace_settings.name = "Non-Color"
img.pixels.foreach_set(rgba.ravel())
sc = bpy.context.scene
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGB"
sc.render.image_settings.color_depth = "8"
sc.render.image_settings.compression = 100
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save_render(os.path.abspath(OUT), scene=sc)
print("wrote", os.path.abspath(OUT), [round(float(out[..., i].mean()), 4) for i in range(3)],
      [round(float(out[..., i].std()), 3) for i in range(3)])
