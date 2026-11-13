// Dev-only: compose the image shown when a link to the game is shared (1200 x 630).
// Served by the dev server at /social.html; it is not part of the production build.
//
// The game itself runs in a frame of that shape. Play to a good spot, free the mouse to
// freeze the world and orbit, then capture: only the game's picture is saved. The logo and
// tagline shown over the frame are a guide for composing; they are added afterwards by
// brand/compose.py, which lays the same overlay over the saved picture.
import './social.css';
import logoRaw from '../../brand/logo/aster-logo-on-dark.svg?raw';

const W = 1200;
const H = 630;
const PAPER = '#f4ecdc';
const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif";

type Place = 'tl' | 'bl' | 'tr' | 'br' | 'centre';
const PLACES: Array<[Place, string]> = [
  ['bl', 'Bottom left'],
  ['tl', 'Top left'],
  ['tr', 'Top right'],
  ['br', 'Bottom right'],
  ['centre', 'Centre'],
];

/** The part of the game's dev hook (window.__ds, see main.ts) that this page uses. */
interface Site {
  cx: number;
  cz: number;
  radius: number;
  kind: string;
}
interface Hook {
  sim(sec: number): void;
  cam(yaw: number, pitch: number, dist: number): void;
  renderer: { domElement: HTMLCanvasElement };
  day: { day: number };
  player: { board: boolean; carpet: boolean; facing: number; place(x: number, z: number): void; state: { pos: { x: number; y: number; z: number } } };
  figure: { board: boolean; boardOn: boolean; carpet: boolean; pick: boolean };
  /** The game's interface. enterPhoto and exitPhoto are private there, but this page drives them. */
  ui: { state: 'title' | 'playing' | 'menu' | 'photo'; begin(): void; openMenu(): void; closeMenu(): void; enterPhoto(): void; exitPhoto(): void };
  world: {
    cities: { near(x: number, z: number): Site[] };
    sample(x: number, z: number, out: { h: number; rock: number; salt: number }): unknown;
    height(x: number, z: number): number;
  };
}

// ---- the logo, as a nested <svg> that can be placed and sized
const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(logoRaw);
const LOGO_W = box ? Number(box[1]) : 1446;
const LOGO_H = box ? Number(box[2]) : 512;
const LOGO_INNER = logoRaw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Options {
  place: Place;
  tagline: string;
  size: number; // logo height in px, at 1200 x 630
  scrim: boolean;
}

/** The overlay as one SVG: a soft shadow behind the text, the logo, the tagline. */
function overlay(o: Options): string {
  const h = o.size;
  const w = (LOGO_W / LOGO_H) * h;
  const pad = 60;
  const fs = Math.round(h * 0.3);
  const gap = Math.round(h * 0.42);
  const hasTag = o.tagline.trim() !== '';
  const block = h + (hasTag ? gap : 0);
  const right = o.place === 'tr' || o.place === 'br';
  const bottom = o.place === 'bl' || o.place === 'br';
  const centre = o.place === 'centre';
  const x = centre ? (W - w) / 2 : right ? W - pad - w : pad;
  const y = centre ? (H - block) / 2 : bottom ? H - pad - block : pad;
  const tx = centre ? W / 2 : right ? W - pad - 4 : pad + 4;
  const anchor = centre ? 'middle' : right ? 'end' : 'start';

  let scrim = '';
  if (o.scrim) {
    if (centre) scrim = `<rect width="${W}" height="${H}" fill="#0b0806" opacity=".3"/>`;
    else {
      const g = `<linearGradient id="s" x1="${right ? 1 : 0}" y1="${bottom ? 1 : 0}" x2="${right ? 0.4 : 0.6}" y2="${bottom ? 0.15 : 0.85}">
        <stop offset="0" stop-color="#0b0806" stop-opacity=".82"/><stop offset=".62" stop-color="#0b0806" stop-opacity="0"/></linearGradient>`;
      scrim = `<defs>${g}</defs><rect width="${W}" height="${H}" fill="url(#s)"/>`;
    }
  }
  const tag = hasTag
    ? `<text x="${tx}" y="${y + h + gap}" text-anchor="${anchor}" font-family="${SERIF}" font-style="italic" font-size="${fs}" fill="${PAPER}">${esc(o.tagline)}</text>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${scrim}` +
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${LOGO_W} ${LOGO_H}">${LOGO_INNER}</svg>${tag}</svg>`
  );
}

const dataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// ---- the page
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const l = el('label', 'so-field');
  l.append(el('span', undefined, label), control);
  return l;
}

const root = el('main', 'so');

const head = el('header', 'so-head');
head.append(el('h1', undefined, 'Social image'), el('p', undefined, 'Capture the picture a shared link to Aster shows. 1200 × 630.'));

const place = el('select');
place.id = 'so-place';
for (const [v, name] of PLACES) {
  const o = el('option', undefined, name);
  o.value = v;
  place.append(o);
}

const tagline = el('input');
tagline.id = 'so-tagline';
tagline.type = 'text';
tagline.value = 'Take the long way';

const size = el('input');
size.id = 'so-size';
size.type = 'range';
size.min = '64';
size.max = '160';
size.value = '104';

const hour = el('input');
hour.id = 'so-hour';
hour.type = 'range';
hour.min = '0';
hour.max = '1';
hour.step = '0.001';
hour.value = '0.72';
const hourLabel = el('span', undefined, 'Time of day');

const scrim = el('input');
scrim.id = 'so-scrim';
scrim.type = 'checkbox';
scrim.checked = true;
const scrimLabel = el('label', 'so-check');
scrimLabel.append(scrim, 'Shadow behind the text');

const guide = el('input');
guide.id = 'so-guide';
guide.type = 'checkbox';
guide.checked = true;
const guideLabel = el('label', 'so-check');
guideLabel.append(guide, 'Show');

const go = el('button', 'so-go', 'Capture picture');
go.type = 'button';
go.disabled = true;

const hourField = el('label', 'so-field');
hourField.append(hourLabel, hour);

// ---- the scene: where the wanderer is, what they carry, what hour it is
const select = (id: string, items: Array<[string, string]>) => {
  const s = el('select');
  s.id = id;
  for (const [v, name] of items) {
    const o = el('option', undefined, name);
    o.value = v;
    s.append(o);
  }
  return s;
};
const check = (id: string, text: string) => {
  const c = el('input');
  c.id = id;
  c.type = 'checkbox';
  const l = el('label', 'so-check');
  l.append(c, text);
  return { input: c, label: l };
};

const goTo = select('so-goto', [['', 'Go to…']]);
const board = select('so-board', [
  ['off', 'No board'],
  ['ride', 'Riding it'],
  ['back', 'On the back'],
]);
const carpet = check('so-carpet', 'Carpet');
const pick = check('so-pick', 'Pick');
const HOURS: Array<[string, string]> = [
  ['', 'Jump to…'],
  ['0.27', 'Dawn'],
  ['0.36', 'Morning'],
  ['0.5', 'Noon'],
  ['0.72', 'Golden hour'],
  ['0.742', 'Sunset'],
  ['0.77', 'Dusk'],
  ['0.95', 'Night'],
];
const jump = select('so-jump', HOURS);

const free = el('button', 'so-free', 'Free the mouse');
free.type = 'button';
free.disabled = true;
const key = (k: string) => el('kbd', undefined, k);
free.append(' ', key('Tab'));
board.title = 'B cycles the board';
carpet.label.append(' ', key('V'));
pick.label.append(' ', key('N'));

const scene = el('div', 'so-bar');
scene.append(el('strong', 'so-group', 'Scene'), field('Location', goTo), field('Board · B', board), carpet.label, pick.label, hourField, field('Hour', jump), free);

const bar = el('div', 'so-bar');
bar.append(el('strong', 'so-group', 'Guide'), guideLabel, field('Logo position · L', place), field('Tagline', tagline), field('Logo size', size), scrimLabel, el('span', 'so-aside', 'Not saved with the picture.'), go);

const frame = el('div', 'so-frame');
const game = el('iframe');
game.title = 'Aster';
// The board and the carpet are lent for this visit, so any spot can be reached.
game.src = '/?tools=board,carpet,pick&day=0.72';
game.allow = 'fullscreen';
const over = el('img');
over.alt = '';
frame.append(game, over);
const stage = el('div', 'so-stage');
stage.append(frame);

const foot = el('footer', 'so-foot');
const hint = (keys: string[], text: string) => {
  const s = el('span');
  for (const k of keys) s.append(el('kbd', undefined, k), ' ');
  s.append(text);
  return s;
};
const status = el('span', 'so-status');
status.setAttribute('role', 'status');
foot.append(
  hint([], 'Click the game to begin.'),
  hint(['Tab'], 'frees the mouse and freezes the world: drag to orbit, scroll to zoom. Tab again to play on.'),
  hint([',', '.'], 'earlier, later.'),
  hint(['P'], 'captures.'),
  status,
);

root.append(head, scene, bar, stage, foot);
document.body.append(root);

// ---- overlay preview
const options = (): Options => ({ place: place.value as Place, tagline: tagline.value, size: Number(size.value), scrim: scrim.checked });
const refresh = () => (over.src = dataUrl(overlay(options())));
for (const c of [place, tagline, size, scrim]) c.addEventListener('input', refresh);
guide.addEventListener('change', () => (over.hidden = !guide.checked));
refresh();

// ---- the game's dev hook, once the frame has loaded
let hook: Hook | null = null;
const clock = (d: number) => {
  const m = Math.round(d * 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
let dragging = false;
hour.addEventListener('pointerdown', () => (dragging = true));
window.addEventListener('pointerup', () => (dragging = false));
const setHour = (d: number) => {
  if (!hook) return;
  hook.day.day = d % 1;
  hook.sim(0.05); // a few steps so the light follows, drawn even if the game is resting in its menu
  hour.value = String(hook.day.day);
  hourLabel.textContent = `Time of day · ${clock(hook.day.day)}`;
};
hour.addEventListener('input', () => setHour(Number(hour.value)));
jump.addEventListener('change', () => {
  if (jump.value) setHour(Number(jump.value));
  jump.value = '';
});

// ---- equipment. The figure shows it; the player object decides how the wanderer moves.
const applyKit = () => {
  if (!hook) return;
  const b = board.value;
  hook.figure.board = b !== 'off';
  hook.figure.boardOn = b === 'ride';
  hook.player.board = b === 'ride';
  hook.figure.carpet = hook.player.carpet = carpet.input.checked;
  hook.figure.pick = pick.input.checked;
  hook.sim(0.05);
};
for (const c of [board, carpet.input, pick.input]) c.addEventListener('change', applyKit);
const readKit = () => {
  if (!hook) return;
  board.value = !hook.figure.board ? 'off' : hook.figure.boardOn ? 'ride' : 'back';
  carpet.input.checked = hook.figure.carpet;
  pick.input.checked = hook.figure.pick;
};

// ---- places: the nearest cities, from outside and from within, and the tallest dunes around
const KIND: Record<string, string> = { hill: 'Walled hill town', canyon: 'Canyon city', oasis: 'Oasis', salt: 'Salt-pan city' };
const places = new Map<string, () => void>();
const arrive = (x: number, z: number, facing: number, dist = 9) => {
  if (!hook) return;
  hook.player.place(x, z);
  hook.player.facing = facing;
  hook.cam(facing + Math.PI + 0.25, 0.1, dist);
  hook.sim(1); // let the camera settle behind the wanderer
};
function crests(px: number, pz: number): Array<{ x: number; z: number; rise: number }> {
  if (!hook) return [];
  const w = hook.world;
  const s = { h: 0, rock: 0, salt: 0 };
  const found: Array<{ x: number; z: number; rise: number }> = [];
  for (let x = px - 3000; x <= px + 3000; x += 75) {
    for (let z = pz - 3000; z <= pz + 3000; z += 75) {
      w.sample(x, z, s);
      if (s.rock > 0.05 || s.salt > 0.05) continue;
      const around = (w.height(x + 150, z) + w.height(x - 150, z) + w.height(x, z + 150) + w.height(x, z - 150)) / 4;
      found.push({ x, z, rise: s.h - around });
    }
  }
  found.sort((a, b) => b.rise - a.rise);
  // Keep the best few that are well apart.
  const out: typeof found = [];
  for (const c of found) {
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 600)) out.push(c);
    if (out.length === 4) break;
  }
  return out;
}
function listPlaces(): void {
  if (!hook) return;
  const p = hook.player.state.pos;
  places.clear();
  goTo.replaceChildren();
  const first = el('option', undefined, 'Go to…');
  first.value = '';
  goTo.append(first);
  const group = (title: string) => {
    const g = el('optgroup');
    g.label = title;
    goTo.append(g);
    return g;
  };
  const add = (g: HTMLOptGroupElement, id: string, name: string, go: () => void) => {
    const o = el('option', undefined, name);
    o.value = id;
    g.append(o);
    places.set(id, go);
  };
  const km = (d: number) => `${(d / 1000).toFixed(1)} km`;
  const sites = hook.world.cities.near(p.x, p.z).slice(0, 5);
  const outside = group('Towns, from outside');
  const inside = group('Towns, from within');
  sites.forEach((c, i) => {
    const name = `${KIND[c.kind] ?? c.kind} · ${km(Math.hypot(c.cx - p.x, c.cz - p.z))}`;
    // Approach from the side the wanderer is already on.
    const a = Math.atan2(p.x - c.cx, p.z - c.cz);
    const at = (r: number) => ({ x: c.cx + Math.sin(a) * r, z: c.cz + Math.cos(a) * r });
    add(outside, `out${i}`, name, () => {
      const q = at(c.radius + 380);
      arrive(q.x, q.z, Math.atan2(c.cx - q.x, c.cz - q.z), 12);
    });
    add(inside, `in${i}`, name, () => {
      const q = at(c.radius * 0.5);
      arrive(q.x, q.z, Math.atan2(c.cx - q.x, c.cz - q.z), 10);
    });
  });
  const dunes = group('Dunes nearby');
  crests(p.x, p.z).forEach((c, i) => {
    add(dunes, `dune${i}`, `Crest, ${Math.round(c.rise)} m above the sand around · ${km(Math.hypot(c.x - p.x, c.z - p.z))}`, () => arrive(c.x, c.z, hook ? hook.player.facing : 0));
  });
}
goTo.addEventListener('change', () => {
  places.get(goTo.value)?.();
  listPlaces(); // distances are from where the wanderer now stands
});

// ---- staying in the game. While playing, the game holds the pointer, so the panel cannot be
// reached. Tab swaps to photo mode, which frees the pointer and freezes the world, and back.
// The controls that matter also have keys, and using a control hands the keyboard back.
const toGame = () => game.contentWindow?.focus();
function toggleFree(): void {
  if (!hook) return;
  const ui = hook.ui;
  const doc = game.contentDocument;
  if (ui.state === 'title') ui.begin();
  if (ui.state === 'playing') {
    ui.openMenu();
    ui.enterPhoto();
    doc?.exitPointerLock();
  } else if (ui.state === 'menu') ui.enterPhoto();
  else if (ui.state === 'photo') {
    ui.exitPhoto();
    ui.closeMenu(); // resumes and takes the pointer again
  }
  toGame();
}
free.addEventListener('click', toggleFree);
const cycle = (s: HTMLSelectElement) => {
  s.selectedIndex = (s.selectedIndex + 1) % s.options.length;
};
function shortcut(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type === 'text') return;
  let used = true;
  if (e.code === 'Tab') toggleFree();
  else if (e.repeat && e.code !== 'Comma' && e.code !== 'Period') return;
  else if (e.code === 'KeyP') void capture();
  else if (e.code === 'Comma') setHour((hook ? hook.day.day : 0) + 1 - (e.shiftKey ? 0.02 : 0.004));
  else if (e.code === 'Period') setHour((hook ? hook.day.day : 0) + (e.shiftKey ? 0.02 : 0.004));
  else if (e.code === 'KeyB') (cycle(board), applyKit());
  else if (e.code === 'KeyV') ((carpet.input.checked = !carpet.input.checked), applyKit());
  else if (e.code === 'KeyN') ((pick.input.checked = !pick.input.checked), applyKit());
  else if (e.code === 'KeyL') (cycle(place), refresh());
  else used = false;
  if (used) {
    e.preventDefault();
    e.stopPropagation();
  }
}
// The same keys work with the panel focused, except while typing the tagline.
window.addEventListener('keydown', shortcut, true);
// After a choice in the panel, the keyboard goes back to the game.
for (const c of [goTo, board, jump, place]) c.addEventListener('change', toGame);
for (const c of [carpet.input, pick.input, scrim, guide]) c.addEventListener('change', toGame);
for (const c of [hour, size]) c.addEventListener('pointerup', toGame);
tagline.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') toGame();
});

const find = window.setInterval(() => {
  const w = game.contentWindow as (Window & { __ds?: Hook }) | null;
  if (!w?.__ds) return;
  window.clearInterval(find);
  hook = w.__ds;
  go.disabled = false;
  readKit();
  listPlaces();
  free.disabled = false;
  w.addEventListener('keydown', shortcut, true);
  // Follow the game's own clock while the slider is not being held.
  window.setInterval(() => {
    if (!hook || dragging) return;
    hour.value = String(hook.day.day);
    hourLabel.textContent = `Time of day · ${clock(hook.day.day)}`;
    const held = hook.ui.state === 'playing';
    free.firstChild!.textContent = held ? 'Free the mouse' : hook.ui.state === 'photo' ? 'Back to the game' : 'Free the mouse';
    free.classList.toggle('is-free', hook.ui.state === 'photo');
  }, 500);
}, 200);

// ---- capture: the game's picture alone, at the size the game drew it
function picture(): HTMLCanvasElement {
  if (!hook) throw new Error('The game has not loaded yet.');
  // The game clears its drawing buffer after each frame, so draw one and copy it straight away.
  hook.sim(0);
  const src = hook.renderer.domElement;
  // Crop to 1200 : 630 in case the game canvas is a hair off it.
  const sw = Math.round(Math.min(src.width, (src.height * W) / H));
  const sh = Math.round((sw * H) / W);
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas.');
  ctx.drawImage(src, Math.round((src.width - sw) / 2), Math.round((src.height - sh) / 2), sw, sh, 0, 0, sw, sh);
  return out;
}

async function capture(): Promise<void> {
  try {
    const out = picture();
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (!blob) throw new Error('The picture could not be encoded.');
    const name = `aster-social-${Date.now()}.png`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status.textContent = `Saved ${name} (${out.width} × ${out.height}), picture only.`;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
  }
}
go.addEventListener('click', () => void capture());

if (import.meta.env.DEV) Object.assign(window, { __social: { picture, overlay, options } });
