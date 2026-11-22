"""Bake public/art/detail.png: tileable 512x512 surface detail, one channel per surface.
R woven cloth, G limewashed plaster, B dressed stone / mud-brick. Each channel is mid-grey 0.5
on average (the shader reads texel - 0.5). All maths is periodic, so it tiles in both axes.
Run: blender --background --python tools/blender/detail.py"""
import os
import bpy
import numpy as np

N = 512
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "art", "detail.png")
rng = np.random.default_rng(7)
fx = np.fft.fftfreq(N)[None, :] * N
fy = np.fft.fftfreq(N)[:, None] * N
RAD = np.sqrt(fx * fx + fy * fy)
U, V = np.meshgrid(np.arange(N) / N, np.arange(N) / N)  # U along x (columns), V along y (rows)


def band_noise(lo, hi, aniso=(1.0, 1.0), seed=None):
    """Periodic noise band-limited to radial frequencies lo..hi (cycles per tile), unit std."""
    r = np.random.default_rng(seed) if seed is not None else rng
    w = r.standard_normal((N, N))
    rr = np.sqrt((fx * aniso[0]) ** 2 + (fy * aniso[1]) ** 2)
    f = np.exp(-((rr - 0.5 * (lo + hi)) / max(0.5 * (hi - lo), 1e-3)) ** 2)
    a = np.real(np.fft.ifft2(np.fft.fft2(w) * f))
    return a / a.std()


def norm(a, std):
    a = a - a.mean()
    return a / a.std() * std


# ---- R: plain weave, 48 threads
T = 48
wob_u = band_noise(1, 5, seed=1) * 0.07
wob_v = band_noise(1, 5, seed=2) * 0.07
cu = U * T + wob_u[0:1, :].repeat(N, 0) * 1.0 + band_noise(2, 8, seed=3) * 0.05
cv = V * T + wob_v[:, 0:1].repeat(N, 1) * 1.0 + band_noise(2, 8, seed=4) * 0.05
iu, iv = np.floor(cu).astype(int), np.floor(cv).astype(int)
fu, fv = cu - iu, cv - iv
amp_u = 1.0 + 0.18 * np.random.default_rng(5).standard_normal(T + 1)
amp_v = 1.0 + 0.18 * np.random.default_rng(6).standard_normal(T + 1)
au = amp_u[iu % T]
av = amp_v[iv % T]
wb = np.sin(np.pi * fu) ** 0.8 * au          # warp thread cross-section
sb = np.sin(np.pi * fv) ** 0.8 * av          # weft thread cross-section
over = ((iu + iv) % 2) == 0
h = np.where(over, wb * (0.75 + 0.25 * np.sin(np.pi * fv)), sb * (0.75 + 0.25 * np.sin(np.pi * fu)))
h -= 0.35 * np.where(over, sb, wb) * 0.0
cloth = norm(h, 0.17)

# ---- G: limewash, low contrast
sweep = band_noise(2, 9, aniso=(1.0, 0.45), seed=11)       # long soft trowel arcs
sweep2 = band_noise(2, 8, aniso=(0.5, 1.0), seed=12)
grit = band_noise(40, 90, seed=13)
mott = band_noise(6, 24, seed=14)
cracks = np.zeros((N, N))
cr = np.random.default_rng(15)
for _ in range(4):
    x, y = cr.uniform(0, N, 2)
    ang = cr.uniform(0, 2 * np.pi)
    for _s in range(int(cr.uniform(70, 150))):
        ang += cr.normal(0, 0.35)
        x += np.cos(ang) * 1.5
        y += np.sin(ang) * 1.5
        cracks[int(y) % N, int(x) % N] = 1.0
# thin the cracks to ~1.5px lines, soft
cracks = np.real(np.fft.ifft2(np.fft.fft2(cracks) * np.exp(-(RAD / 90.0) ** 2)))
cracks = cracks / cracks.max()
plaster = 0.55 * sweep + 0.35 * sweep2 + 0.25 * mott + 0.22 * grit
plaster = norm(plaster, 0.07) - 0.20 * np.clip(cracks * 1.4, 0, 1)

# ---- B: dressed stone / mud brick
pits = np.maximum(band_noise(35, 90, seed=21), 0) ** 2
stone = 0.45 * band_noise(40, 100, seed=22) - 0.5 * (pits - pits.mean()) + 0.55 * band_noise(5, 20, seed=23) \
    + 0.3 * band_noise(25, 60, seed=24)
stone = norm(stone, 0.09)

out = np.zeros((N, N, 3))
for i, c in enumerate((cloth, plaster, stone)):
    c = np.clip(c + 0.5, 0, 1)
    c = c - c.mean() + 0.5
    c = np.round(c * 255 / 4) * 4 / 255  # coarse levels: invisible at the shader's gain, keeps the PNG small
    out[..., i] = np.clip(c, 0, 1)

rgba = np.ones((N, N, 4), dtype=np.float32)
rgba[..., :3] = out
rgba = rgba[::-1]  # Blender rows run bottom-up
img = bpy.data.images.new("detail", N, N, alpha=False, float_buffer=False)
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
