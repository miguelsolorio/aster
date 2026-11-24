// The ?perf overlay: frame timing, draw calls and quality tier in a corner box, and the same
// numbers on window.__perf for scripts (see tools/perf/). Nothing is created without ?perf.
import type { WebGLRenderer } from 'three';
import type { AutoQuality } from './quality';
import { setPerfMark } from './perfMark';

const RING = 600; // frame times kept
const SHOW_EVERY = 250; // ms between box updates

export interface PerfHud {
  /** At the top of a rAF callback that will draw, with its timestamp. */
  frameStart(rafNow: number): void;
  /** Time since the previous mark is charged to this label (update sections, render passes). */
  mark(label: string): void;
  /** A one-off event worth seeing next to the spikes (tier or pace change, a city staged, ...). */
  note(msg: string): void;
  /** Just before the frame's draw calls. */
  begin(): void;
  /** Just after them, with the rAF timestamp. */
  end(now: number): void;
}

interface PerfData {
  frames: number[]; // the last RING frame times, ms, oldest first
  count: number; // frames timed since load (frames.length stops at RING)
  fps: number;
  median: number;
  worst: number;
  over50: number;
  over100: number;
  longTasks: number;
  calls: number;
  triangles: number;
  programs: number;
  tier: string;
  pace: number; // the frame-rate target: 60, or an even 30
  refreshHz: number; // the display, as measured
  renderScale: number;
  heapMB: number | null;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

export function createPerfHud(renderer: WebGLRenderer, auto: AutoQuality): PerfHud | null {
  if (!new URLSearchParams(location.search).has('perf')) return null;
  // The scene and the post pass are two render() calls a frame: count them together.
  renderer.info.autoReset = false;

  const data: PerfData = {
    frames: [],
    count: 0,
    fps: 0,
    median: 0,
    worst: 0,
    over50: 0,
    over100: 0,
    longTasks: 0,
    calls: 0,
    triangles: 0,
    programs: 0,
    tier: auto.tier,
    pace: auto.pace,
    refreshHz: 60,
    renderScale: auto.renderScale,
    heapMB: null,
  };
  (window as unknown as { __perf: PerfData }).__perf = data;

  try {
    new PerformanceObserver((list) => {
      data.longTasks += list.getEntries().length;
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* no long task support */
  }

  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:99999;pointer-events:none;white-space:pre;font:11px/1.3 ui-monospace,Menlo,monospace;color:#fff;' +
    'background:rgba(0,0,0,.55);padding:4px 6px;border-radius:4px;' +
    'top:max(6px,env(safe-area-inset-top));right:max(6px,env(safe-area-inset-right))';
  document.body.appendChild(box);

  const times: Array<[number, number]> = []; // [timestamp, ms] over the last 5 s
  let last = 0;
  let shown = 0;

  // Spike log: every frame over 40 ms (or with over 25 ms of work) is recorded with where its time
  // went, and sent to the dev server (vite.config.ts writes it to tools/perf/out/device.jsonl), so a
  // phone session can be read on the Mac. Safari has no long-task API, so this is the only way to see.
  const marks: Array<[string, number]> = [];
  let markT = 0;
  let startT = 0;
  let lateMs = 0; // how long after its vsync timestamp the callback began: main-thread work outside rAF
  const queue: unknown[] = [];
  const notes: string[] = [];
  const gaps: number[] = []; // raw rAF-to-rAF gaps of drawn frames, for the summary
  const session = Math.random().toString(36).slice(2, 8);
  const send = () => {
    if (!queue.length) return;
    const body = JSON.stringify({ session, ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight, items: queue.splice(0) });
    try {
      fetch('/__perf', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
    } catch {
      /* not served by the dev server */
    }
  };
  setInterval(() => {
    if (gaps.length) {
      const g = [...gaps].sort((a, b) => a - b);
      const q = (f: number) => +g[Math.min(g.length - 1, Math.floor(g.length * f))].toFixed(1);
      queue.push({ kind: 'summary', t: Math.round(performance.now()), fps: data.fps, median: data.median, worst: data.worst, over50: data.over50, over100: data.over100, p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99), tier: auto.tier, scale: auto.renderScale, pace: auto.pace, hz: Math.round(1 / auto.refreshS), calls: data.calls, tris: data.triangles, progs: data.programs });
      gaps.length = 0;
    }
    send();
  }, 4000);
  addEventListener('pagehide', send);

  setPerfMark((label) => {
    const t = performance.now();
    marks.push([label, t - markT]);
    markT = t;
  });

  return {
    frameStart(rafNow) {
      startT = markT = performance.now();
      lateMs = startT - rafNow;
      marks.length = 0;
    },
    mark(label) {
      const t = performance.now();
      marks.push([label, t - markT]);
      markT = t;
    },
    note(msg) {
      notes.push(msg);
      queue.push({ kind: 'note', t: Math.round(performance.now()), msg });
    },
    begin() {
      renderer.info.reset();
    },
    end(now) {
      const info = renderer.info;
      data.calls = info.render.calls;
      data.triangles = info.render.triangles;
      data.programs = info.programs?.length ?? 0;
      if (last) {
        const ms = now - last;
        data.frames.push(ms);
        if (data.frames.length > RING) data.frames.shift();
        data.count++;
        times.push([now, ms]);
        if (ms > 50) data.over50++;
        if (ms > 100) data.over100++;
        gaps.push(ms);
        const work = performance.now() - startT;
        if (ms > 40 || work > 25) {
          const top = marks.filter((m) => m[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 6).map((m) => `${m[0]} ${m[1].toFixed(1)}`);
          queue.push({ kind: 'spike', t: Math.round(now), gap: +ms.toFixed(1), work: +work.toFixed(1), late: +lateMs.toFixed(1), top, calls: info.render.calls, tier: auto.tier, scale: auto.renderScale, pace: auto.pace });
        }
      }
      last = now;
      while (times.length && now - times[0][0] > 5000) times.shift();
      if (now - shown < SHOW_EVERY) return;
      shown = now;

      let n = 0;
      for (let i = times.length - 1; i >= 0 && now - times[i][0] <= 1000; i--) n++;
      const ms = times.map((t) => t[1]);
      data.fps = n;
      data.median = median(ms);
      data.worst = ms.length ? Math.max(...ms) : 0;
      data.tier = auto.tier;
      data.pace = auto.pace;
      data.refreshHz = Math.round(1 / auto.refreshS);
      data.renderScale = auto.renderScale;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      data.heapMB = mem ? mem.usedJSHeapSize / 1048576 : null;

      box.textContent =
        `${data.fps} fps  med ${data.median.toFixed(1)}  worst ${data.worst.toFixed(0)} ms\n` +
        `>50: ${data.over50}  >100: ${data.over100}  long: ${data.longTasks}\n` +
        `${data.calls} calls  ${(data.triangles / 1000).toFixed(0)}k tris  ${data.programs} prog\n` +
        `${data.tier} x${data.renderScale}  pace ${data.pace}${auto.paced ? '' : ' (uncapped)'}  ${data.refreshHz} Hz` +
        (data.heapMB !== null ? `  ${data.heapMB.toFixed(0)} MB` : '');
    },
  };
}
