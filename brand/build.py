"""Generates the Aster logo and banner explorations into <repo>/brand."""
import base64, json, math, os, random, sys
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1]
os.makedirs(OUT + '/logos', exist_ok=True)
os.makedirs(OUT + '/banners', exist_ok=True)

# ---------------------------------------------------------------- palette (35 mm look)
SKY, HORIZON, SAND, SHADE, SUN = '#0f4f6e', '#7fc3a6', '#d9a04e', '#6e4a24', '#fff1c9'
N_SKY, N_HOR, N_SAND, N_SHADE, MOON = '#050d1a', '#12303a', '#5f8a8c', '#0e1c24', '#d8f0e6'
S_SKY, S_HOR, S_SAND, S_SHADE, S_SUN = '#153a5c', '#e9a25a', '#d98a3c', '#4a2a22', '#ffcf8a'
INK, PAPER, CLOTH, ACCENT = '#1a1410', '#f4ecdc', '#1c1512', '#e9c98f'
MAUVE, GOLD = '#8c6670', '#e0b65c'

# ---------------------------------------------------------------- type, outlined to paths
_ttc = TTCollection('/System/Library/Fonts/Supplemental/Iowan Old Style.ttc')
ROMAN, ITALIC, TITLING = _ttc.fonts[0], _ttc.fonts[2], _ttc.fonts[6]


_caps = {}


def capheight(font):
    if id(font) not in _caps:
        from fontTools.pens.boundsPen import BoundsPen
        gs = font.getGlyphSet()
        bp = BoundsPen(gs)
        gs[font.getBestCmap()[ord('H')]].draw(bp)
        _caps[id(font)] = bp.bounds[3]
    return _caps[id(font)]


def text(s, font, cap, x=0.0, y=0.0, track=0.0, anchor='start'):
    """Path data for s with cap height `cap` px, baseline at y. Returns (d, width)."""
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    k = cap / capheight(font)
    upm = font['head'].unitsPerEm
    adv, names = [], []
    for ch in s:
        g = cmap.get(ord(ch), '.notdef')
        names.append(g)
        adv.append(gs[g].width * k + track * upm * k)
    width = sum(adv) - track * upm * k
    cx = x - (width / 2 if anchor == 'middle' else width if anchor == 'end' else 0)
    out = []
    for g, a in zip(names, adv):
        pen = SVGPathPen(gs, ntos=lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
        gs[g].draw(TransformPen(pen, (k, 0, 0, -k, cx, y)))
        out.append(pen.getCommands())
        cx += a
    return ''.join(out), width


def P(d, fill, extra=''):
    return f'<path d="{d}" fill="{fill}"{(" " + extra) if extra else ""}/>'


# ---------------------------------------------------------------- shared shapes
def star4(cx, cy, R, r=None, f=0.13):
    """Four-point aster. Sides bow in towards the centre."""
    r = R if r is None else r
    a, b = f * r, f * R
    return (f'M{cx} {cy - R}Q{cx + a:.1f} {cy - b:.1f} {cx + r} {cy}Q{cx + a:.1f} {cy + b:.1f} {cx} {cy + R}'
            f'Q{cx - a:.1f} {cy + b:.1f} {cx - r} {cy}Q{cx - a:.1f} {cy - b:.1f} {cx} {cy - R}Z')


def fig(cx, foot, h):
    """The wanderer: a pointed hooded cone with a ragged hem. Returns (body d, legs d, face cx, cy, r)."""
    top, hem = foot - h, foot - 0.10 * h
    f = lambda dx, dy: f'{cx + dx * h:.1f} {top + dy * h:.1f}'
    body = (f'M{f(0, 0)}C{f(.09, .22)} {f(.25, .6)} {cx + .30 * h:.1f} {hem:.1f}'
            f'L{cx + .19 * h:.1f} {hem - .06 * h:.1f}L{cx + .09 * h:.1f} {hem + .01 * h:.1f}'
            f'L{cx - .03 * h:.1f} {hem - .06 * h:.1f}L{cx - .15 * h:.1f} {hem + .01 * h:.1f}'
            f'L{cx - .30 * h:.1f} {hem - .04 * h:.1f}C{f(-.25, .6)} {f(-.09, .22)} {f(0, 0)}Z')
    w = 0.028 * h
    legs = ''.join(f'M{cx + s * .07 * h - w / 2:.1f} {hem - .05 * h:.1f}h{w:.1f}V{foot:.1f}h{-w:.1f}Z' for s in (-1, 1))
    return body, legs, cx + 0.015 * h, top + 0.30 * h, 0.10 * h


def figure(cx, foot, h, cloth=CLOTH, face=PAPER):
    b, l, fx, fy, fr = fig(cx, foot, h)
    return P(b + l, cloth) + f'<circle cx="{fx:.1f}" cy="{fy:.1f}" r="{fr:.1f}" fill="{face}"/>'


def grad(i, a, b, x2=0, y2=1):
    return (f'<linearGradient id="{i}" x1="0" y1="0" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>')


RSQ = '<rect width="512" height="512" rx="116"/>'
CIRC = '<circle cx="256" cy="256" r="256"/>'
RIDGE = 'M0 344C140 334 240 262 336 204'           # crest, left part (where shade meets sky)
LIT = RIDGE + 'C408 172 462 180 512 196V512H0Z'      # whole dune
SLIP = RIDGE + 'C306 292 372 372 316 512H0Z'         # shaded slip face
S_CURVE = 'M256 0C138 132 384 300 256 512'
A_OUT = 'M256 120C300 262 384 392 484 460H28C136 392 216 262 256 120Z'
A_SHADE = 'M256 120C216 262 136 392 28 460H250C304 384 222 252 256 120Z'
CARPET = 'M82 338L316 296L432 346L198 392Z'
CARPET_IN = 'M124 340L312 307L390 344L202 378Z'


def petals(lit, shade, R=244, w=46, inner=26):
    out = []
    for i in range(8):
        a = i * 45
        out.append(f'<g transform="rotate({a} 256 256)">'
                   + P(f'M256 {256 - inner}C{256 + w} {256 - R * .38} {256 + w * .8} {256 - R * .72} 256 {256 - R}Z', lit)
                   + (P(f'M256 {256 - inner}C{256 - w} {256 - R * .38} {256 - w * .8} {256 - R * .72} 256 {256 - R}Z', shade) if shade else '')
                   + '</g>')
    return ''.join(out)


# ---------------------------------------------------------------- the ten marks (512 x 512)
def mark(n, u):
    """Full-colour symbol n. `u` prefixes ids so several can share one document."""
    c = f'clip-path="url(#{u}c)"'
    if n == 1:
        return (f'<defs>{grad(u + "g", SKY, HORIZON)}<clipPath id="{u}c">{RSQ}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/><circle cx="372" cy="128" r="34" fill="{SUN}"/>'
                + P(LIT, SAND) + P(SLIP, SHADE) + '</g>')
    if n == 2:
        return (f'<defs>{grad(u + "g", N_SKY, N_HOR)}<clipPath id="{u}c">{CIRC}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/>' + P(star4(330, 140, 86), MOON)
                + ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{MOON}" opacity=".7"/>' for x, y, r in [(120, 110, 5), (190, 196, 4), (446, 250, 5), (232, 70, 3)])
                + P(LIT, N_SAND) + P(SLIP, N_SHADE) + '</g>')
    if n == 3:
        return (f'<defs><clipPath id="{u}c">{CIRC}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="{SAND}"/>' + figure(256, 660, 600) + '</g>')
    if n == 4:
        return (f'<defs><clipPath id="{u}c">{CIRC}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="{SAND}"/>' + P(S_CURVE + 'H0V0Z', SHADE) + '</g>')
    if n == 5:
        return f'<g transform="rotate(45 256 256)">{P(star4(256, 256, 132, None, .1), SAND)}</g>' + P(star4(256, 256, 252, 196, .2), SAND)
    if n == 6:
        return (f'<defs>{grad(u + "g", S_SKY, S_HOR)}<clipPath id="{u}c">{RSQ}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/><circle cx="402" cy="132" r="40" fill="{S_SUN}"/>'
                + P(CARPET, CLOTH) + P(CARPET_IN, MAUVE)
                + ''.join(f'<path d="M{x} {y}l{dx} {dy}" stroke="{GOLD}" stroke-width="9" stroke-linecap="round"/>'
                          for x, y, dx, dy in [(82, 338, -26, 12), (198, 392, -22, 16), (316, 296, 24, -14), (432, 346, 28, -10)])
                + figure(262, 350, 232) + '</g>')
    if n == 7:
        return P(A_OUT, SAND) + P(A_SHADE, SHADE) + P(star4(256, 52, 66), SAND)
    if n == 8:
        d, w = text('A', TITLING, 300, 256, 378, anchor='middle')
        wave = 'M0 340C90 318 170 352 262 332S430 318 512 342V512H0Z'
        sh = f'<g transform="translate(0 338) skewX(-58) scale(1 -.3) translate(0 -338)" opacity=".55">{P(d, S_SHADE)}</g>'
        return (f'<defs>{grad(u + "g", S_SKY, S_HOR)}<clipPath id="{u}c">{RSQ}</clipPath><clipPath id="{u}s"><path d="{wave}"/></clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/>' + P(d, PAPER) + P(wave, S_SAND)
                + f'<g clip-path="url(#{u}s)">{sh}</g></g>')
    if n == 9:
        return petals(SAND, SHADE)
    if n == 10:
        dune = 'M0 404C110 392 196 346 256 304C318 346 402 392 512 404V512H0Z'
        return (f'<defs>{grad(u + "g", SKY, HORIZON)}{grad(u + "n", N_SKY, N_HOR)}<clipPath id="{u}c">{CIRC}</clipPath>'
                f'<clipPath id="{u}l"><rect width="256" height="512"/></clipPath><clipPath id="{u}r"><rect x="256" width="256" height="512"/></clipPath></defs><g {c}>'
                f'<rect width="256" height="512" fill="url(#{u}g)"/><rect x="256" width="256" height="512" fill="url(#{u}n)"/>'
                f'<circle cx="138" cy="168" r="36" fill="{SUN}"/>' + P(star4(376, 168, 52), MOON)
                + f'<g clip-path="url(#{u}l)">{P(dune, SAND)}</g><g clip-path="url(#{u}r)">{P(dune, N_SAND)}</g>'
                + figure(256, 310, 124) + '</g>')


def mono(n, u):
    """One-colour version of symbol n, drawn in currentColor."""
    cc = 'currentColor'

    def masked(shape, cuts, keep=''):
        return (f'<defs><mask id="{u}m" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">'
                f'<g fill="#fff">{shape}</g><g fill="#000" stroke="#000" stroke-width="0">{cuts}</g><g fill="#fff">{keep}</g></mask></defs>'
                f'<g mask="url(#{u}m)" fill="{cc}">{shape}</g>')

    lit_only = RIDGE + 'C408 172 462 180 512 196V512H316C372 372 306 292 336 204Z'
    crest = f'<path d="{RIDGE}C408 172 462 180 512 196" fill="none" stroke-width="16"/>'
    if n == 1:
        return masked(RSQ, f'<circle cx="372" cy="128" r="34"/>{crest}<path d="M336 204C306 292 372 372 316 512" fill="none" stroke-width="16"/>')
    if n == 2:
        return masked(CIRC, f'<path d="{star4(330, 140, 86)}"/>{crest}<path d="M336 204C306 292 372 372 316 512" fill="none" stroke-width="16"/>')
    if n == 3:
        b, l, fx, fy, fr = fig(256, 660, 600)
        return masked(CIRC, f'<path d="{b}"/>', f'<circle cx="{fx}" cy="{fy}" r="{fr}"/>')
    if n == 4:
        return (f'<defs><clipPath id="{u}c">{CIRC}</clipPath></defs><g clip-path="url(#{u}c)">' + P(S_CURVE + 'H0V0Z', cc)
                + f'</g><circle cx="256" cy="256" r="247" fill="none" stroke="{cc}" stroke-width="18"/>')
    if n == 5:
        return f'<g transform="rotate(45 256 256)">{P(star4(256, 256, 132, None, .1), cc)}</g>' + P(star4(256, 256, 252, 196, .2), cc)
    if n == 6:
        b, l, fx, fy, fr = fig(262, 350, 232)
        return masked(RSQ, f'<circle cx="402" cy="132" r="40"/><path d="{CARPET}"/><path d="{b}{l}"/>',
                      f'<circle cx="{fx:.1f}" cy="{fy:.1f}" r="{fr:.1f}"/>')
    if n == 7:
        return (P(A_SHADE, cc) + f'<path d="{A_OUT}" fill="none" stroke="{cc}" stroke-width="16" stroke-linejoin="round"/>'
                + P(star4(256, 52, 66), cc))
    if n == 8:
        d, w = text('A', TITLING, 300, 256, 378, anchor='middle')
        return (f'<defs><clipPath id="{u}c"><path d="M0 0H512V340C430 318 354 312 262 332S90 318 0 340Z"/></clipPath></defs>'
                f'<g clip-path="url(#{u}c)">{P(d, cc)}</g>'
                f'<path d="M20 366C100 344 174 376 262 356S420 342 492 364" fill="none" stroke="{cc}" stroke-width="16" stroke-linecap="round"/>')
    if n == 9:
        return petals(cc, None)
    if n == 10:
        b, l, fx, fy, fr = fig(256, 310, 124)
        dune = 'M0 404C110 392 196 346 256 304C318 346 402 392 512 404V512H0Z'
        return (masked(CIRC, f'<path d="M0 0H256V304C196 346 110 392 0 404Z"/><path d="{star4(376, 168, 52)}"/>'
                             f'<path d="M256 304C318 346 402 392 512 404" fill="none" stroke-width="14"/><path d="{b}" stroke-width="16"/>',
                       f'<circle cx="138" cy="168" r="36"/><path d="{b}{l}"/>').replace('</mask>', f'<circle cx="{fx:.1f}" cy="{fy:.1f}" r="{fr:.1f}" fill="#000"/></mask>')
                + f'<circle cx="256" cy="256" r="248" fill="none" stroke="{cc}" stroke-width="16"/>')


# ---------------------------------------------------------------- lockups
NAMES = {
    1: ('Sun and ridge', 'simple', 'The current icon, cleaned up. Your baseline.'),
    2: ('Night star', 'simple', 'The aster itself, over a moonlit dune.'),
    3: ('The wanderer', 'simple', 'Hood and white face. The only mark with a character.'),
    4: ('Ridge line', 'simple', 'One crest, light on one side and shadow on the other.'),
    5: ('Compass star', 'simple', 'One colour. An aster that is also a compass rose.'),
    6: ('Carpet rider', 'simple', 'The tasselled carpet in flight at sunset.'),
    7: ('Dune A', 'exploratory', 'The A is a dune with a star at its peak.'),
    8: ('Buried letters', 'exploratory', 'The name half sunk in sand, casting shadows.'),
    9: ('Aster of ridges', 'exploratory', 'Eight dune ridges seen from above form the flower.'),
    10: ('Day and night', 'exploratory', 'One disc, both halves of the day cycle, the wanderer on the crest.'),
}
# wordmark setting per logo: (string, font, tracking in em)
WORD = {1: ('Aster', ROMAN, 0), 2: ('ASTER', TITLING, .14), 3: ('Aster', ROMAN, 0), 4: ('Aster', ROMAN, 0),
        5: ('ASTER', TITLING, .22), 6: ('Aster', ROMAN, 0), 9: ('Aster', ROMAN, 0), 10: ('ASTER', TITLING, .14)}


def buried(u, ink, cap=300, bg=True):
    """Logo 8: the word itself, half sunk. Returns (svg inner, w, h)."""
    d, w = text('ASTER', TITLING, cap, 110, 378, track=.06)
    W = w + 220
    wave = f'M0 340C{W * .16:.0f} 314 {W * .3:.0f} 356 {W * .5:.0f} 332S{W * .84:.0f} 314 {W:.0f} 344V512H0Z'
    sh = f'<g transform="translate(0 338) skewX(-58) scale(1 -.3) translate(0 -338)" opacity=".55">{P(d, S_SHADE)}</g>'
    if bg:
        return (f'<defs>{grad(u + "g", S_SKY, S_HOR)}<clipPath id="{u}c"><rect width="{W:.0f}" height="512" rx="116"/></clipPath>'
                f'<clipPath id="{u}s"><path d="{wave}"/></clipPath></defs><g clip-path="url(#{u}c)">'
                f'<rect width="{W:.0f}" height="512" fill="url(#{u}g)"/>' + P(d, PAPER) + P(wave, S_SAND)
                + f'<g clip-path="url(#{u}s)">{sh}</g></g>', W, 512)
    return d, wave, W


def lockup(n, u, ink):
    """Symbol and wordmark side by side. Returns (svg inner, width, height=512)."""
    if n == 8:
        return buried(u, ink)
    if n == 7:
        d, w = text('STER', TITLING, 340, 500, 460, track=.05)
        return mark(7, u) + P(d, ink), 500 + w, 512
    s, font, tr = WORD[n]
    cap = 236 if font is ROMAN else 196
    d, w = text(s, font, cap, 632, 256 + cap / 2, track=tr)
    return mark(n, u) + P(d, ink), 632 + w, 512


def svg(inner, w, h, extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}"{extra}>{inner}</svg>'


def write(path, s):
    with open(os.path.join(OUT, path), 'w') as f:
        f.write(s)


# ---------------------------------------------------------------- chosen identity
# Logo: 09, the aster of ridges. App icon: 01, sun and ridge.
import shutil
for old in ('logos', 'banners'):
    shutil.rmtree(os.path.join(OUT, old), ignore_errors=True)
for d_ in ('logo', 'icon', 'og'):
    os.makedirs(os.path.join(OUT, d_), exist_ok=True)

TAG1 = 'The desert is your map'
TAG2 = 'A calm desert to wander, glide and fly through'


def aster(light=False):
    """The mark. `light` is the version for photographs: pale petals with sand shadows."""
    return petals(PAPER, SAND) if light else petals(SAND, SHADE)


def lock9(ink, light=False):
    d, w = text('Aster', ROMAN, 236, 632, 256 + 118)
    return aster(light) + P(d, ink), 632 + w


def stack9(ink, light=False):
    d, w = text('Aster', ROMAN, 190, 256, 512 + 110 + 190, anchor='middle')
    return aster(light) + P(d, ink), 512, 830


def tag(s, x, y, fill, cap=21, anchor='start'):
    d, w = text(s, ITALIC, cap, x, y, anchor=anchor)
    return P(d, fill)


def photo(u, name):
    with open(os.path.join(OUT, 'shots', name + '.jpg'), 'rb') as f:
        b = base64.b64encode(f.read()).decode()
    return f'<defs><image id="{u}ph" href="data:image/jpeg;base64,{b}" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/></defs>'


def scrim(u, x1, y1, x2, y2, col, a=.8, stop=.6):
    return (f'<defs><linearGradient id="{u}s" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"><stop offset="0" stop-color="{col}" stop-opacity="{a}"/>'
            f'<stop offset="{stop}" stop-color="{col}" stop-opacity="0"/></linearGradient></defs><rect width="1200" height="630" fill="url(#{u}s)"/>')


def lock(ink, light, x, y, h):
    inner, w = lock9(ink, light)
    return f'<g transform="translate({x:.1f} {y:.1f}) scale({h / 512:.4f})">{inner}</g>', w * h / 512


def stack(ink, light, cx, y, h):
    inner, w, hh = stack9(ink, light)
    k = h / hh
    return f'<g transform="translate({cx - w * k / 2:.1f} {y:.1f}) scale({k:.4f})">{inner}</g>'


def amark(cx, cy, size, light=False, deep=False):
    k = size / 512
    return f'<g transform="translate({cx - size / 2:.1f} {cy - size / 2:.1f}) scale({k:.4f})">{petals("#c07f2a", "#54361a") if deep else aster(light)}</g>'


def word(cap, x, y, fill, anchor='start'):
    return P(text('Aster', ROMAN, cap, x, y, anchor=anchor)[0], fill)


DARK = '#14100d'
MUTED = '#6b5d4c'


# ---------------------------------------------------------------- round two: ten new logo ideas
shutil.rmtree(os.path.join(OUT, 'og'), ignore_errors=True)
shutil.rmtree(os.path.join(OUT, 'logos'), ignore_errors=True)
os.makedirs(os.path.join(OUT, 'og'))
os.makedirs(os.path.join(OUT, 'logos'))


def asterisk(cx, cy, R, t, fill):
    return ''.join(f'<rect x="{cx - t / 2}" y="{cy - R}" width="{t}" height="{2 * R}" rx="{t / 2}" fill="{fill}" transform="rotate({a} {cx} {cy})"/>' for a in (0, 60, 120))


def nmark(n, u):
    c = f'clip-path="url(#{u}c)"'
    if n == 1:   # bold aster seal
        return (f'<circle cx="256" cy="256" r="256" fill="{DARK}"/><circle cx="256" cy="256" r="234" fill="none" stroke="{SAND}" stroke-width="5" opacity=".6"/>'
                + petals(SAND, SHADE, R=204, w=82, inner=0))
    if n == 2:   # the app icon as a roundel
        return (f'<defs>{grad(u + "g", SKY, HORIZON)}<clipPath id="{u}c">{CIRC}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/><circle cx="366" cy="136" r="38" fill="{SUN}"/>' + P(LIT, SAND) + P(SLIP, SHADE) + '</g>')
    if n == 3:   # the sun becomes the aster
        return (f'<defs>{grad(u + "g", SKY, HORIZON)}<clipPath id="{u}c">{RSQ}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/>'
                f'<g transform="translate(346 142) scale(.5) translate(-256 -256)">{petals(SUN, ACCENT, R=250, w=70, inner=0)}</g>'
                + P(LIT, SAND) + P(SLIP, SHADE) + '</g>')
    if n == 4:   # asterisk tile
        return f'<rect width="512" height="512" rx="116" fill="{DARK}"/>' + asterisk(256, 256, 170, 64, SAND)
    if n == 5:   # woven carpet
        tass = ''.join(f'<rect x="{x}" y="{y}" width="20" height="46" rx="8" fill="{GOLD}"/>' for x in (86, 146, 206, 266, 326, 386) for y in (14, 452))
        return (tass + f'<rect x="56" y="52" width="400" height="408" rx="26" fill="{CLOTH}"/><rect x="92" y="88" width="328" height="336" rx="10" fill="{MAUVE}"/>'
                + f'<rect x="112" y="108" width="288" height="296" rx="4" fill="none" stroke="{GOLD}" stroke-width="6"/>'
                + P(star4(256, 256, 118, None, .2), GOLD) + f'<g transform="rotate(45 256 256)">{P(star4(256, 256, 84, None, .2), CLOTH)}</g>'
                + f'<circle cx="256" cy="256" r="16" fill="{GOLD}"/>')
    if n == 6:   # dune A
        return (f'<rect width="512" height="512" rx="116" fill="{DARK}"/>' + P('M256 78L436 438H352L256 232Z', SAND) + P('M256 78V232L160 438H76Z', SHADE)
                + f'<circle cx="256" cy="372" r="40" fill="{SUN}"/>')
    if n == 7:   # the wanderer before the sun
        return (f'<defs>{grad(u + "g", S_SKY, S_HOR)}<clipPath id="{u}c">{CIRC}</clipPath></defs><g {c}>'
                f'<rect width="512" height="512" fill="url(#{u}g)"/><circle cx="256" cy="258" r="150" fill="{S_SUN}"/>'
                + P('M0 404C120 396 200 372 256 366C330 372 420 400 512 396V512H0Z', S_SHADE) + figure(256, 380, 236) + '</g>')
    if n == 8:   # a trail to a star
        dots = ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{PAPER}"/>' for x, y, r in
                       [(112, 420, 17), (176, 386, 16), (232, 342, 15), (252, 284, 14), (232, 230, 13), (254, 182, 12), (300, 152, 11)])
        return f'<rect width="512" height="512" rx="116" fill="{DARK}"/>' + dots + P(star4(376, 126, 72, None, .16), SAND)
    if n == 9:   # a doorway on the night
        outer = 'M92 512V236A164 164 0 0 1 420 236V512Z'
        inner = 'M156 512V242A100 100 0 0 1 356 242V512Z'
        return (f'<defs>{grad(u + "g", N_SKY, N_HOR)}<clipPath id="{u}c"><path d="{inner}"/></clipPath><clipPath id="{u}l"><rect width="256" height="512"/></clipPath></defs>'
                + P(outer, SAND) + f'<g clip-path="url(#{u}l)">{P(outer, SHADE)}</g>'
                + f'<g {c}><rect width="512" height="512" fill="url(#{u}g)"/>' + P(star4(256, 262, 62), MOON)
                + P('M100 452C180 430 250 410 300 400C340 420 380 440 420 446V512H100Z', N_SAND) + '</g>')
    if n == 10:  # ridge underline: favicon is an A on its ridge
        d, w = text('A', ROMAN, 250, 256, 352, anchor='middle')
        return (f'<rect width="512" height="512" rx="116" fill="{DARK}"/>' + P(d, PAPER)
                + P('M70 440C190 380 330 378 446 404C330 398 190 410 70 440Z', SAND) + P('M70 440C190 410 330 398 446 404C340 428 200 446 70 440Z', SHADE))


NEW = {
    1: ('Bold aster', 'The flower you picked, with heavier petals on its own ink disc so it holds on any background.'),
    2: ('Sun and ridge', 'Your app icon promoted to the logo, as a roundel.'),
    3: ('Aster rising', 'Your app icon, with the sun replaced by the flower.'),
    4: ('Asterisk', 'Aster is where the asterisk gets its name. One bold glyph.'),
    5: ('Woven carpet', 'The tasselled carpet seen from above, with a star in the weave.'),
    6: ('Dune A', 'An A built from a lit face and a shaded face, with the sun inside.'),
    7: ('Wanderer and sun', 'The figure on a crest in front of a low sun, like the sunset captures.'),
    8: ('Trail to a star', 'Footprints leading to a star. The desert is your map.'),
    9: ('Doorway', 'A city arch opening onto the night sky.'),
    10: ('Ridge underline', 'The name first, underlined by a single dune ridge.'),
}


def nlock(n, u, ink):
    if n == 4:
        d, w = text('Aster', ROMAN, 236, 0, 374)
        return P(d, ink) + asterisk(w + 92, 150, 78, 30, SAND), w + 180
    if n == 10:
        d, w = text('Aster', ROMAN, 236, 20, 344)
        W = w + 40
        return (P(d, ink) + P(f'M0 448C{W * .3:.0f} 384 {W * .62:.0f} 380 {W:.0f} 408C{W * .68:.0f} 402 {W * .36:.0f} 414 0 448Z', SAND)
                + P(f'M0 448C{W * .36:.0f} 414 {W * .68:.0f} 402 {W:.0f} 408C{W * .7:.0f} 432 {W * .4:.0f} 452 0 448Z', SHADE)), W
    d, w = text('Aster', ROMAN, 236, 632, 374)
    return nmark(n, u) + P(d, ink), 632 + w


# ---------------------------------------------------------------- cinematic scenes, name only
def scene(n, name, layout, tagline, col):
    u = f'og{n}'
    out = photo(u, name) + f'<use href="#{u}ph"/>'
    if layout == 'tl':
        out += scrim(u, 0, 0, .55, .9, col, .7) + word(62, 76, 138, PAPER) + tag(tagline, 80, 190, PAPER, 22)
    elif layout == 'bl':
        out += scrim(u, 0, 1, .6, .15, col, .85) + word(62, 76, 520, PAPER) + tag(tagline, 80, 572, PAPER, 22)
    elif layout == 'tr':
        out += scrim(u, 1, 0, .45, .9, col, .7) + word(62, 1124, 138, PAPER, 'end') + tag(tagline, 1122, 190, PAPER, 22, 'end')
    return svg(out, 1200, 630, ' width="1200" height="630" xmlns:xlink="http://www.w3.org/1999/xlink"')


SCENES = [
    ('into-the-sun', 'Into the sun', 'bl', TAG1),
    ('massif-golden', 'The massif at golden hour', 'tl', TAG1),
    ('under-the-dune', 'Under the dune', 'tl', TAG1),
    ('ridge-golden', 'On the ridge', 'tl', TAG2),
    ('steep-dune', 'The steep face', 'bl', TAG1),
    ('carpet-sunset', 'Flying into the sunset', 'tl', TAG2),
    ('afterglow', 'Afterglow', 'tl', TAG1),
    ('sunrise', 'Sunrise over the river', 'tr', TAG1),
]

data = {'logos': [], 'scenes': [], 'prev': {'w': round(lock9(INK)[1]), 'a': lock9('currentColor')[0], 'mark': [aster(), aster(), aster()]}}
for n in range(1, 11):
    inner, w = nlock(n, f'l{n}', INK)
    write(f'logos/logo-{n:02d}.svg', svg(inner, w, 512))
    write(f'logos/logo-{n:02d}-on-dark.svg', svg(nlock(n, f'l{n}', PAPER)[0], w, 512))
    write(f'logos/logo-{n:02d}-mark.svg', svg(nmark(n, f'm{n}'), 512, 512))
    data['logos'].append({'n': n, 'name': NEW[n][0], 'note': NEW[n][1], 'w': round(w),
                          'lock': [nlock(n, f'g{n}{k}', 'currentColor')[0] for k in 'abc'], 'mark': [nmark(n, f'g{n}m{i}') for i in range(3)]})
for i, (name, title, layout, tl) in enumerate(SCENES, 1):
    write(f'og/og-{i:02d}.svg', scene(i, name, layout, tl, '#160c06'))
    data['scenes'].append({'n': i, 'name': title})
with open(sys.argv[2], 'w') as f:
    json.dump(data, f)
print('ok')

# ---------------------------------------------------------------- the chosen logo: 01, the bold aster
for src, dst in [('logos/logo-01.svg', 'logo/aster-logo.svg'), ('logos/logo-01-on-dark.svg', 'logo/aster-logo-on-dark.svg'), ('logos/logo-01-mark.svg', 'logo/aster-mark.svg')]:
    shutil.copyfile(os.path.join(OUT, src), os.path.join(OUT, dst))
for stale in ('aster-logo-on-photo.svg', 'aster-logo-stacked.svg', 'aster-mark-mono.svg'):
    p = os.path.join(OUT, 'logo', stale)
    if os.path.exists(p):
        os.remove(p)
