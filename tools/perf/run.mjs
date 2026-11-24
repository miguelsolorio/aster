#!/usr/bin/env node
// Repeatable mobile-ish profiling of the game: system Chrome, iPhone 13 emulation, CPU throttled.
// See README.md. Usage: node tools/perf/run.mjs [--throttle 8] [--seconds 20] [--scenarios a,b] [--trace] [--out dir] [--url http://...]
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

// ---- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const THROTTLE = Number(opt('throttle', 8));
const SECONDS = Number(opt('seconds', 20));
const TRACE = argv.includes('--trace');
const OUT = path.resolve(opt('out', path.join(here, 'out')));
const GIVEN_URL = opt('url', '');
const JS_FLAGS = opt('js-flags', '');
const SETTLE_MS = 7000;

// name -> { query, hold (key to hold), board (tap the board button first), seconds (window, if not --seconds) }
const SCENARIOS = {
  still: { query: '?day=0.45' },
  run: { query: '', hold: 'w' },
  board: { query: '?tools=board', board: true, hold: 'w' },
  city: { query: '?miner' },
  stepped: { query: '?settle=stepped-city' },
  cavern: { query: '?cavern', hold: 'w' },
  // standing in the thick of a sandstorm (dev-only ?storm=in)
  storm: { query: '?storm=in&day=0.45' },
  night: { query: '?day=0.95&tools=chart', hold: 'w' },
  // 1.7 km out from a city's edge, walking in: the full city appears about 12 s into the window
  cityApproach: { query: '?approach=1700&day=0.45', hold: 'w' },
  // riding the board straight on for 40 s (settle included): across the load radii of several cities
  travel: { query: '?tools=board', board: true, hold: 'w', seconds: 33 },
};
const names = opt('scenarios', Object.keys(SCENARIOS).join(',')).split(',').filter(Boolean);
for (const n of names) if (!SCENARIOS[n]) fail(`unknown scenario "${n}" (have ${Object.keys(SCENARIOS).join(', ')})`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---- playwright: not a dependency of the game
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

// ---- dev server
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
const stopServer = () => server?.kill();
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// ---- the spike log the game posts under ?perf (vite.config.ts perfLog appends it here)
const DEVICE_LOG = path.join(root, 'tools/perf/out/device.jsonl');
const logSize = () => {
  try {
    return fs.statSync(DEVICE_LOG).size;
  } catch {
    return 0;
  }
};
/** The spike records appended to the log between two sizes of it. */
function readSpikes(from, to) {
  if (to <= from) return [];
  const fd = fs.openSync(DEVICE_LOG, 'r');
  const buf = Buffer.alloc(to - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      for (const it of JSON.parse(line).items ?? []) if (it.kind === 'spike') out.push(it);
    } catch {}
  }
  return out;
}
/** Spike sections ("cities.extra 38.0") by label: how many spikes each was in the top of, and the worst. */
function spikeSections(spikes) {
  const by = new Map();
  for (const sp of spikes) {
    for (const t of sp.top ?? []) {
      const i = t.lastIndexOf(' ');
      const label = t.slice(0, i);
      const ms = Number(t.slice(i + 1));
      const e = by.get(label) ?? { label, count: 0, max: 0 };
      e.count++;
      e.max = Math.max(e.max, ms);
      by.set(label, e);
    }
  }
  return [...by.values()].sort((a, b) => b.max - a.max);
}

// ---- stats
const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const r1 = (x) => Math.round(x * 10) / 10;

function summarize(ft, longTasks, samples) {
  const s = [...ft].sort((a, b) => a - b);
  const med = (k) => {
    const v = samples.map((x) => x[k]).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 0;
  };
  return {
    frames: ft.length,
    median: r1(q(s, 0.5)),
    p95: r1(q(s, 0.95)),
    p99: r1(q(s, 0.99)),
    over33: ft.filter((x) => x > 33).length,
    over50: ft.filter((x) => x > 50).length,
    over100: ft.filter((x) => x > 100).length,
    max: r1(s[s.length - 1] ?? 0),
    longTasks,
    calls: med('calls'),
    triangles: med('triangles'),
  };
}

// ---- trace: top self-time functions inside slow frames
function analyzeTrace(events, thr = 33) {
  const fa = events.filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X');
  if (!fa.length) return { slow: 0, top: [] };
  const pid = fa[0].pid;
  const nodes = new Map();
  const samples = [];
  const prof = events.find((e) => e.name === 'Profile' && e.pid === pid);
  let t = prof?.args?.data?.startTime ?? 0;
  const chunks = events.filter((e) => e.name === 'ProfileChunk' && e.pid === pid);
  for (const c of chunks) {
    const cp = c.args.data.cpuProfile;
    for (const n of cp.nodes ?? []) nodes.set(`${c.id}:${n.id}`, n);
    const td = c.args.data.timeDeltas ?? [];
    (cp.samples ?? []).forEach((s, i) => {
      t += td[i] ?? 0;
      samples.push([t, `${c.id}:${s}`]);
    });
  }
  samples.sort((a, b) => a[0] - b[0]);
  const slow = fa.filter((e) => e.dur / 1000 > thr).sort((a, b) => a.ts - b.ts);
  const self = {};
  let n = 0;
  for (const e of slow) {
    for (const [ts, id] of samples) {
      if (ts < e.ts) continue;
      if (ts > e.ts + e.dur) break;
      const cf = nodes.get(id)?.callFrame;
      if (!cf) continue;
      const k = `${cf.functionName || '(anon)'}  ${(cf.url || '').replace(/^.*\/(src\/)/, '$1').replace(/^.*\//, '')}:${cf.lineNumber + 1}`;
      self[k] = (self[k] || 0) + 1;
      n++;
    }
  }
  const top = Object.entries(self)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([fn, c]) => ({ fn, pct: r1((100 * c) / Math.max(1, n)) }));
  return { slow: slow.length, top };
}

// ---- one scenario
async function runScenario(browser, base, name) {
  const sc = SCENARIOS[name];
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/?perf${sc.query ? `&${sc.query.slice(1)}` : ''}`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await page.locator('button.aster-btn--primary', { hasText: 'Start' }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1000);
  if (sc.board) {
    // ?tools=board may already have you on it; Q does not toggle it under touch emulation, the on-screen button does.
    const riding = () => page.evaluate(() => window.__ds?.player?.board);
    if (!(await riding())) {
      const btn = page.locator('.aster-touch__board');
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      const bb = await btn.boundingBox();
      await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.waitForTimeout(500);
    }
    if (!(await riding())) throw new Error('could not get on the board');
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  if (sc.hold) await page.keyboard.down(sc.hold);

  const chunks = [];
  // __perf.frames is a ring of 600, so poll often and keep every frame that is new since the last poll.
  // The settle is polled too: its frames are in the whole-run stats (that is when the cities around
  // the start build their extras), not in the settled ones.
  const ft = [];
  const samples = [];
  let seen = null;
  const poll = async () => {
    const s = await page.evaluate(() => {
      const p = window.__perf;
      return { count: p.count, tail: p.frames.slice(-200), calls: p.calls, triangles: p.triangles, programs: p.programs, tier: p.tier, scale: p.renderScale, pace: p.pace, heap: p.heapMB, long: p.longTasks };
    });
    if (seen === null) seen = { count: s.count, long: s.long };
    else {
      const fresh = Math.min(s.count - seen.count - ft.length, s.tail.length);
      if (fresh > 0) ft.push(...s.tail.slice(-fresh));
    }
    samples.push({ calls: s.calls, triangles: s.triangles, programs: s.programs, tier: s.tier, scale: s.scale, pace: s.pace, heap: s.heap });
    return s;
  };
  await poll();
  const settleEnd = Date.now() + SETTLE_MS;
  while (Date.now() < settleEnd) {
    await page.waitForTimeout(250);
    await poll();
  }
  const settled = ft.length;
  const longAtSettle = (await poll()).long;
  if (TRACE) {
    cdp.on('Tracing.dataCollected', (e) => chunks.push(...e.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,v8.gc,disabled-by-default-v8.cpu_profiler,blink.user_timing', transferMode: 'ReportEvents' });
  }
  const end = Date.now() + (sc.seconds ?? SECONDS) * 1000;
  let lastPoll;
  while (Date.now() < end) {
    await page.waitForTimeout(250);
    lastPoll = await poll();
  }
  if (sc.hold) await page.keyboard.up(sc.hold);
  const raw = { ft: ft.slice(settled), all: ft, long: lastPoll.long - longAtSettle };
  // send the spike log now rather than on its 4 s timer
  await page.evaluate(() => dispatchEvent(new Event('pagehide'))).catch(() => {});
  await page.waitForTimeout(600);

  let traceInfo = null;
  if (TRACE) {
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    fs.writeFileSync(path.join(OUT, `${name}.trace.json`), JSON.stringify(chunks));
    traceInfo = analyzeTrace(chunks);
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await ctx.close();
  return { raw, samples, traceInfo, errors };
}

// ---- main
fs.mkdirSync(OUT, { recursive: true });
const base = await startServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--use-angle=metal', '--enable-precise-memory-info', ...(JS_FLAGS ? [`--js-flags=${JS_FLAGS}`] : [])],
});
const rows = [];
const allSpikes = [];
try {
  for (const name of names) {
    process.stderr.write(`running ${name} ...\n`);
    let res;
    const log0 = logSize();
    try {
      res = await runScenario(browser, base, name);
    } catch (e) {
      console.error(`${name}: FAILED ${e.message.split('\n')[0]}`);
      rows.push({ scenario: name, skipped: e.message.split('\n')[0] });
      continue;
    }
    const ft = res.raw.ft;
    const row = { scenario: name, ...summarize(ft, res.raw.long, res.samples), tier: res.samples.at(-1)?.tier, scale: res.samples.at(-1)?.scale, pace: res.samples.at(-1)?.pace };
    row.longTasks = res.raw.long;
    // the whole run, settle included
    row.allMax = r1(Math.max(0, ...res.raw.all));
    row.allOver50 = res.raw.all.filter((x) => x > 50).length;
    const spikes = readSpikes(log0, logSize());
    row.spikes = spikes.length;
    row.sections = spikeSections(spikes).slice(0, 10);
    allSpikes.push(...spikes);
    rows.push(row);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ row, frames: ft, all: res.raw.all, samples: res.samples, trace: res.traceInfo, errors: res.errors, spikes }));
    if (res.traceInfo) {
      console.log(`\n${name}: top self time inside frames >33 ms (${res.traceInfo.slow} frames)`);
      for (const t of res.traceInfo.top) console.log(`  ${String(t.pct).padStart(5)}%  ${t.fn}`);
    }
  }
} finally {
  await browser.close();
  stopServer();
}

let sha = '';
try {
  sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ sha, date: new Date().toISOString(), throttle: THROTTLE, seconds: SECONDS, rows }, null, 2));

const cols = ['scenario', 'median', 'p95', 'p99', 'over33', 'over50', 'over100', 'max', 'allMax', 'allOver50', 'longTasks', 'calls', 'triangles', 'tier', 'scale', 'pace'];
console.log(`\nthrottle ${THROTTLE}x, ${SECONDS}s, ${sha} (allMax, allOver50: the whole run, settle included)`);
console.log(cols.join('\t'));
for (const r of rows) console.log(r.skipped ? `${r.scenario}\tSKIPPED: ${r.skipped}` : cols.map((c) => r[c]).join('\t'));

// where the slow frames went, from the game's own spike log (whole runs)
const top = spikeSections(allSpikes).slice(0, 10);
console.log(`\ntop spike sections (${allSpikes.length} spikes; in how many spikes' top, worst ms):`);
if (top.length === 0) console.log('  (none logged: is the dev server this script started serving ?perf, and tools/perf/out writable?)');
for (const t of top) console.log(`  ${t.label.padEnd(28)} ${String(t.count).padStart(4)}  ${t.max.toFixed(1).padStart(7)}`);
for (const r of rows) if (r.sections?.length) console.log(`  ${r.scenario}: ${r.sections.slice(0, 3).map((t) => `${t.label} ${t.max.toFixed(1)}`).join(', ')}`);
