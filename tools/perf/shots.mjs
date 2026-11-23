#!/usr/bin/env node
// Deterministic screenshots of fixed views, for checking that a rendering change looks the same.
// See README.md.
//   node tools/perf/shots.mjs [--out tools/perf/out/shots/base] [--tiers mobile,high] [--views a,b] [--url http://...]
//   node tools/perf/shots.mjs --diff <dirA> <dirB> [--out <dir for heat maps and report>]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};

// name -> query (after ?perf&), and optional setup: face [x, z] to look at, cam [pitch, dist], look id, gallery
// The game is frozen (__ds.freeze) from its first frame, so the clock, sun, clouds and stars hold
// still; after Start a fixed number of 60 Hz steps (__ds.sim) lets the camera settle behind the figure.
const VIEWS = {
  'desert-noon': { query: 'day=0.5' },
  'dunes-golden': { query: 'day=0.72', yaw: 1.9 },
  mountain: { query: 'day=0.45&x=5415&z=-7000', face: [7476, -7399], cam: [0.05, 9] },
  city: { query: 'miner&day=0.45' },
  'city-far': { query: 'approach=200&day=0.45', cam: [0.08, 9], faceCity: true },
  night: { query: 'day=0.95', cam: [0.45, 9] },
  'night-moon': { query: 'day=0.82', cam: [-0.2, 6], faceMoon: true, yaw: 0.12 },
  salt: { query: 'day=0.4&x=-624&z=-5699' },
  down: { query: 'day=0.55', cam: [1.2, 16] },
  'look-lowpoly': { query: 'day=0.5', look: 'lowpoly' },
  'look-map': { query: 'day=0.6', look: 'map' },
  'look-ink': { query: 'day=0.72', look: 'ink' },
  gallery: { gallery: true },
};
const TIERS = {
  mobile: { device: 'iPhone 13' },
  high: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_PATH) tries.push(process.env.PLAYWRIGHT_PATH);
  tries.push(null, '/Users/solorio/dev/souvie/node_modules');
  for (const t of tries) {
    try {
      const req = t ? createRequire(path.join(path.resolve(t), 'noop.js')) : createRequire(import.meta.url);
      return req('playwright');
    } catch {}
  }
  return fail('Could not load playwright. Set PLAYWRIGHT_PATH to a node_modules directory that contains it.');
}
const { chromium, devices } = loadPlaywright();

// ---------------------------------------------------------------- diff
if (argv[0] === '--diff') {
  const [a, b] = [argv[1], argv[2]].map((d) => path.resolve(d));
  const out = path.resolve(opt('out', path.join(b, 'diff')));
  fs.mkdirSync(out, { recursive: true });
  const files = fs.readdirSync(a).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(b, f)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const rows = [];
  for (const f of files) {
    const [ia, ib] = [a, b].map((d) => fs.readFileSync(path.join(d, f)).toString('base64'));
    const r = await page.evaluate(
      async ([ia, ib]) => {
        const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const [A, B] = [await load(ia), await load(ib)];
        if (A.width !== B.width || A.height !== B.height) return { error: `size ${A.width}x${A.height} vs ${B.width}x${B.height}` };
        const w = A.width;
        const h = A.height;
        const px = (img) => {
          const c = new OffscreenCanvas(w, h);
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, w, h).data;
        };
        const da = px(A);
        const db = px(B);
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        const heat = g.createImageData(w, h);
        let max = 0;
        let sum = 0;
        let over2 = 0;
        let over8 = 0;
        let over24 = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
          if (d > max) max = d;
          sum += d;
          if (d > 2) over2++;
          if (d > 8) over8++;
          if (d > 24) over24++;
          // the image dimmed to grey, with the difference in red (x8)
          const grey = 0.25 * (0.3 * da[i] + 0.59 * da[i + 1] + 0.11 * da[i + 2]);
          heat.data[i] = Math.min(255, grey + d * 8);
          heat.data[i + 1] = grey;
          heat.data[i + 2] = grey;
          heat.data[i + 3] = 255;
        }
        g.putImageData(heat, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const n = da.length / 4;
        return { max, mean: sum / n, over2: over2 / n, over8: over8 / n, over24: over24 / n, heat: btoa(bin) };
      },
      [ia, ib],
    );
    if (r.error) {
      rows.push({ file: f, error: r.error });
      continue;
    }
    fs.writeFileSync(path.join(out, f.replace(/\.png$/, '.heat.png')), Buffer.from(r.heat, 'base64'));
    delete r.heat;
    rows.push({ file: f, ...r });
  }
  await browser.close();
  // stats side by side, when both captures have them
  const stats = (d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'stats.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const sa = stats(a);
  const sb = stats(b);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ a, b, rows, statsA: sa, statsB: sb }, null, 2));
  const pct = (x) => `${(100 * x).toFixed(3)}%`;
  console.log(`diff ${a}\n  -> ${b}\n(max/mean: largest channel delta 0..255 per pixel; >2, >8, >24: share of pixels over that delta)`);
  console.log(['image', 'max', 'mean', '>2', '>8', '>24'].join('\t'));
  for (const r of rows) console.log(r.error ? `${r.file}\t${r.error}` : [r.file.padEnd(26), r.max, r.mean.toFixed(4), pct(r.over2), pct(r.over8), pct(r.over24)].join('\t'));
  const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort();
  if (keys.length) {
    console.log(`\n${['shot', 'calls', 'tris(k)', 'terrainVerts(k)', 'gpu ms (scene pass, median)'].join('\t')}`);
    const f = (s, k) => (s?.[k] === undefined || s?.[k] === null ? '-' : s[k]);
    for (const k of keys) {
      const A = sa[k];
      const B = sb[k];
      console.log(
        [
          k.padEnd(26),
          `${f(A, 'calls')} -> ${f(B, 'calls')}`,
          `${A ? Math.round(A.triangles / 1000) : '-'} -> ${B ? Math.round(B.triangles / 1000) : '-'}`,
          `${A?.terrainVerts != null ? Math.round(A.terrainVerts / 1000) : '-'} -> ${B?.terrainVerts != null ? Math.round(B.terrainVerts / 1000) : '-'}`,
          `${f(A, 'gpuMs')} -> ${f(B, 'gpuMs')}`,
        ].join('\t'),
      );
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------- capture
const OUT = path.resolve(opt('out', path.join(here, 'out', 'shots', 'base')));
const GIVEN_URL = opt('url', '');
const EVAL = opt('eval', ''); // (debugging) JS run in the page right after Start, e.g. to switch something off
const tierNames = opt('tiers', 'mobile,high').split(',').filter(Boolean);
const viewNames = opt('views', Object.keys(VIEWS).join(',')).split(',').filter(Boolean);
for (const n of viewNames) if (!VIEWS[n]) fail(`unknown view "${n}" (have ${Object.keys(VIEWS).join(', ')})`);
for (const n of tierNames) if (!TIERS[n]) fail(`unknown tier "${n}" (have ${Object.keys(TIERS).join(', ')})`);

let server = null;
const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
async function startServer() {
  if (GIVEN_URL) return GIVEN_URL.replace(/\/$/, '');
  const port = await freePort();
  server = spawn(path.join(root, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return fail('vite did not start');
}
process.on('exit', () => server?.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// Math.random from a fixed seed, so anything scattered at random is scattered the same way each run.
// Some systems draw on it every frame even while frozen, so how many frozen frames ran (wall-clock
// dependent) would shift what the later steps scatter: it is reseeded (__reseed) before each __ds.sim.
// three's generateUUID draws on it too, once per object made, so a change that makes more or fewer
// meshes would shift everything scattered after it: its calls take a stream of their own.
const SEED_SCRIPT = `(() => {
  const gen = (seed) => {
    let s = seed;
    return {
      set: (v) => (s = v | 0),
      next: () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
    };
  };
  const main = gen(0x2f6b1d3);
  const ids = gen(0x1d5);
  window.__reseed = (v) => main.set(v);
  Math.random = () => (new Error().stack.includes('generateUUID') ? ids.next() : main.next());
  // Held, performance.now stands still: the world's per-frame work budgets (world/budget.ts) then
  // never run out inside __ds.sim, so what gets built in which step does not depend on the machine.
  const now = performance.now.bind(performance);
  let held = null;
  performance.now = () => (held ?? now());
  window.__hold = (on) => (held = on ? now() : null);
  // Freeze the game the moment its dev hooks appear, before its first frame: the clock (and so the
  // grain, the cloth, the sky) never moves on real time. No automatic quality changes either.
  let ds;
  Object.defineProperty(window, '__ds', {
    configurable: true,
    get: () => ds,
    set: (v) => {
      ds = v;
      v.auto.frame = () => {};
      // (after start() returns: freeze() reads a variable declared further down it)
      queueMicrotask(() => v.freeze(true));
    },
  });
})();`;

// GPU time of every render() into a target (the scene pass, bakes) per frame, with EXT_disjoint_timer_query_webgl2.
async function gpuTime(page, frames = 60) {
  return page.evaluate(async (frames) => {
    const r = window.__ds.renderer;
    const gl = r.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const orig = r.render;
    const pending = [];
    let frame = 0;
    r.render = function (s, c) {
      if (r.getRenderTarget() === null) return orig.call(this, s, c);
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      orig.call(this, s, c);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({ q, frame });
    };
    const per = new Map();
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    for (let i = 0; i < frames; i++) {
      await raf();
      frame++;
    }
    r.render = orig;
    for (let k = 0; k < 120 && pending.length; k++) {
      await raf();
      for (let i = pending.length - 1; i >= 0; i--) {
        const { q, frame: f } = pending[i];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) per.set(f, (per.get(f) ?? 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
        pending.splice(i, 1);
      }
    }
    const v = [...per.values()].sort((a, b) => a - b);
    return v.length ? Math.round(v[v.length >> 1] * 100) / 100 : null;
  }, frames);
}

async function shootGame(browser, base, tier, name, v) {
  const ctx = await browser.newContext(TIERS[tier].device ? { ...devices[TIERS[tier].device] } : { ...TIERS[tier] });
  await ctx.addInitScript(SEED_SCRIPT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/?perf&${v.query}`, { waitUntil: 'load' });
  await page.locator('button.aster-btn--primary', { hasText: 'Start' }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    [...document.querySelectorAll('button.aster-btn--primary')].find((b) => b.textContent.includes('Start')).click();
  });
  if (EVAL) await page.evaluate(EVAL);
  await page.waitForTimeout(4000);
  await page.evaluate((v) => {
    const ds = window.__ds;
    const p = ds.player.state.pos;
    let facing = ds.player.facing;
    if (v.face) facing = Math.atan2(v.face[0] - p.x, v.face[1] - p.z);
    if (v.faceCity) {
      const c = ds.world.cities.near(p.x, p.z)[0];
      facing = Math.atan2(c.cx - p.x, c.cz - p.z);
    }
    if (v.faceMoon) facing = Math.atan2(ds.day.moonDir.x, ds.day.moonDir.z);
    if (v.yaw !== undefined) facing += v.yaw;
    ds.player.facing = facing;
    const [pitch, dist] = v.cam ?? [0.22, 7.5];
    ds.cam(facing + Math.PI, pitch, dist);
    if (v.look) ds.look(v.look);
    window.__reseed(0x51a7e);
    window.__hold(true);
    ds.sim(3);
    window.__hold(false);
  }, v);
  // let streaming catch up with the settled view (still frozen), then a few more fixed steps
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    window.__reseed(0x9e3779b);
    window.__hold(true);
    window.__ds.sim(0.5);
    window.__hold(false);
  });
  await page.waitForTimeout(1500);
  const gpuMs = await gpuTime(page);
  const st = await page.evaluate(() => {
    const p = window.__perf;
    const cm = window.__ds.clipmap;
    return { calls: p.calls, triangles: p.triangles, tier: p.tier, scale: p.renderScale, terrainVerts: cm?.stats?.vertices ?? null, terrainTiles: cm?.stats?.tiles ?? null };
  });
  await page.addStyleTag({ content: 'body > *:not(#game) { display: none !important; } #game > *:not(canvas) { display: none !important; }' });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${tier}-${name}.png`);
  await page.locator('#game canvas').first().screenshot({ path: file });
  await ctx.close();
  return { ...st, gpuMs, errors };
}

async function shootGallery(browser, base, tier) {
  const ctx = await browser.newContext(TIERS[tier].device ? { ...devices[TIERS[tier].device] } : { ...TIERS[tier] });
  await ctx.addInitScript(SEED_SCRIPT);
  // the gallery animates on the clock: stop it
  await ctx.addInitScript(`(() => {
    const t = 4321;
    performance.now = () => t;
    Date.now = () => 1700000000000;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf(() => cb(t));
  })();`);
  const page = await ctx.newPage();
  await page.goto(`${base}/gallery.html`, { waitUntil: 'load' });
  await page.waitForTimeout(8000);
  const file = path.join(OUT, `${tier}-gallery.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  return {};
}

fs.mkdirSync(OUT, { recursive: true });
const base = await startServer();
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--use-angle=metal'] });
const stats = {};
try {
  for (const tier of tierNames) {
    for (const name of viewNames) {
      const v = VIEWS[name];
      process.stderr.write(`${tier} ${name} ...\n`);
      try {
        const s = v.gallery ? await shootGallery(browser, base, tier) : await shootGame(browser, base, tier, name, v);
        stats[`${tier}-${name}`] = s;
        if (s.errors?.length) console.error(`  page errors: ${s.errors.join(' | ').slice(0, 300)}`);
      } catch (e) {
        console.error(`${tier} ${name}: FAILED ${e.message.split('\n')[0]}`);
      }
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
console.log(`wrote ${Object.keys(stats).length} shots to ${OUT}`);
for (const [k, s] of Object.entries(stats)) if (s.calls !== undefined) console.log(`${k.padEnd(26)} calls ${s.calls}  tris ${Math.round(s.triangles / 1000)}k  terrain verts ${s.terrainVerts ?? '-'}  gpu ${s.gpuMs ?? '-'} ms  tier ${s.tier} x${s.scale}`);
