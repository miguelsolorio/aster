#!/usr/bin/env python3
"""Lay the Aster logo and tagline over a picture captured at /social.html.

    python3 brand/compose.py ~/Downloads/aster-social-123.png
    python3 brand/compose.py picture.png --tagline "A calm desert to wander" --place tl

Writes brand/og/aster-og.svg (the picture embedded, the tagline still live text, so it can
be edited by hand) and brand/og/aster-og.png at 1200 x 630, rendered with rsvg-convert.
The layout mirrors overlay() in src/dev/social.ts, so the guide on that page is what you get.
Only the standard library is needed, plus `sips` (macOS) and `rsvg-convert` on the PATH.
"""
import argparse, base64, html, os, re, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1200, 630
PAPER = '#f4ecdc'
SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif"

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('picture', help='the PNG or JPEG saved by the Capture picture button')
ap.add_argument('--tagline', default='Take the long way', help='empty string for none')
ap.add_argument('--place', default='bl', choices=['tl', 'bl', 'tr', 'br', 'centre'])
ap.add_argument('--size', type=float, default=104, help='logo height in px at 1200 x 630')
ap.add_argument('--no-scrim', action='store_true', help='leave out the shadow behind the text')
ap.add_argument('--logo', default=os.path.join(HERE, 'logo', 'aster-logo-on-dark.svg'))
ap.add_argument('--out', default=os.path.join(HERE, 'og', 'aster-og'), help='output path without extension')
a = ap.parse_args()

# ---- the picture, as a 2400 x 1260 JPEG (cropped to shape if it is not already 1200 : 630)
with tempfile.TemporaryDirectory() as tmp:
    jpg = os.path.join(tmp, 'p.jpg')
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '86', os.path.expanduser(a.picture), '--out', jpg],
                   check=True, capture_output=True)
    photo = base64.b64encode(open(jpg, 'rb').read()).decode()

# ---- the logo, as a nested <svg>
raw = open(a.logo).read()
m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', raw)
lw, lh = (float(m.group(1)), float(m.group(2))) if m else (1446.0, 512.0)
inner = re.sub(r'</svg>\s*$', '', re.sub(r'^[\s\S]*?<svg[^>]*>', '', raw))

h = a.size
w = lw / lh * h
pad = 60
fs = round(h * 0.3)
gap = round(h * 0.42)
has_tag = a.tagline.strip() != ''
block = h + (gap if has_tag else 0)
right, bottom, centre = a.place in ('tr', 'br'), a.place in ('bl', 'br'), a.place == 'centre'
x = (W - w) / 2 if centre else W - pad - w if right else pad
y = (H - block) / 2 if centre else H - pad - block if bottom else pad
tx = W / 2 if centre else W - pad - 4 if right else pad + 4
anchor = 'middle' if centre else 'end' if right else 'start'

scrim = ''
if not a.no_scrim:
    if centre:
        scrim = f'<rect width="{W}" height="{H}" fill="#0b0806" opacity=".3"/>'
    else:
        scrim = (f'<defs><linearGradient id="s" x1="{1 if right else 0}" y1="{1 if bottom else 0}" x2="{0.4 if right else 0.6}" y2="{0.15 if bottom else 0.85}">'
                 f'<stop offset="0" stop-color="#0b0806" stop-opacity=".82"/><stop offset=".62" stop-color="#0b0806" stop-opacity="0"/></linearGradient></defs>'
                 f'<rect width="{W}" height="{H}" fill="url(#s)"/>')
tag = (f'\n  <text x="{tx}" y="{y + h + gap}" text-anchor="{anchor}" font-family="{SERIF}" font-style="italic" font-size="{fs}" fill="{PAPER}">'
       f'{html.escape(a.tagline)}</text>') if has_tag else ''

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">\n'
       f'  <image href="data:image/jpeg;base64,{photo}" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>\n'
       f'  {scrim}\n'
       f'  <svg x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" viewBox="0 0 {lw:g} {lh:g}">{inner}</svg>{tag}\n'
       f'</svg>\n')

os.makedirs(os.path.dirname(a.out), exist_ok=True)
with open(a.out + '.svg', 'w') as f:
    f.write(svg)
subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), a.out + '.svg', '-o', a.out + '.png'], check=True)
print(f'{a.out}.svg\n{a.out}.png  ({os.path.getsize(a.out + ".png") // 1024} KB)')
