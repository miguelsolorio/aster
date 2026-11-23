// The ?perf overlay: frame timing, draw calls and quality tier in a corner box, and the same
// numbers on window.__perf for scripts (see tools/perf/). Nothing is created without ?perf.
import type { WebGLRenderer } from 'three';
import type { AutoQuality } from './quality';

const RING = 600; // frame times kept
const SHOW_EVERY = 250; // ms between box updates

export interface PerfHud {
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

  return {
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
      data.renderScale = auto.renderScale;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      data.heapMB = mem ? mem.usedJSHeapSize / 1048576 : null;

      box.textContent =
        `${data.fps} fps  med ${data.median.toFixed(1)}  worst ${data.worst.toFixed(0)} ms\n` +
        `>50: ${data.over50}  >100: ${data.over100}  long: ${data.longTasks}\n` +
        `${data.calls} calls  ${(data.triangles / 1000).toFixed(0)}k tris  ${data.programs} prog\n` +
        `${data.tier} x${data.renderScale}` +
        (data.heapMB !== null ? `  ${data.heapMB.toFixed(0)} MB` : '');
    },
  };
}
