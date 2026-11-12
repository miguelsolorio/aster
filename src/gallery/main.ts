import './gallery.css';
import { STYLES } from '../render/styles';
import { Stage } from '../render/stage';
import type { Style } from '../render/types';

const TOD_LABELS = ['Day', 'Sunset', 'Night'] as const;
const MIN_PER_FRAME = 2;
const MAX_PER_FRAME = 6;
const FRAME_BUDGET_MS = 10;

interface Tile {
  index: number;
  style: Style;
  button: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  visible: boolean;
  dirty: boolean;
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
const appRoot: HTMLElement = root;

function showMessage(text: string): void {
  appRoot.replaceChildren();
  const p = document.createElement('p');
  p.className = 'message';
  p.textContent = text;
  appRoot.appendChild(p);
}

let stage: Stage | null = null;
try {
  stage = new Stage();
} catch {
  showMessage('Aster needs WebGL to draw these styles, and it could not be started in this browser.');
}

if (stage) {
  start(stage);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function start(stage: Stage): void {
  const styles = STYLES;

  // ---- time of day state -------------------------------------------------
  let target = 0;
  let tod = 0;
  const segButtons: HTMLButtonElement[][] = [];

  function syncSegs(): void {
    for (const group of segButtons) {
      group.forEach((b, i) => b.setAttribute('aria-checked', String(i === target)));
    }
  }

  function setTarget(t: number): void {
    target = t;
    syncSegs();
  }

  function createSeg(): HTMLElement {
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Time of day');
    const group: HTMLButtonElement[] = [];
    TOD_LABELS.forEach((label, i) => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === target));
      b.title = `${label} (${i + 1})`;
      b.addEventListener('click', () => setTarget(i));
      seg.appendChild(b);
      group.push(b);
    });
    segButtons.push(group);
    return seg;
  }

  // ---- page skeleton -----------------------------------------------------
  appRoot.replaceChildren();

  const header = el('header', 'header');
  const brand = el('div', 'brand');
  brand.append(
    el('h1', 'title', 'Aster'),
    el('p', 'subtitle', 'Twenty ways to see the same dune. Pick one, or mix them.'),
  );
  header.append(brand, createSeg());

  const main = el('main');
  const grid = el('div', 'grid');
  main.appendChild(grid);

  const tiles: Tile[] = styles.map((style, index) => {
    const button = el('button', 'tile');
    button.type = 'button';
    button.setAttribute('aria-label', `Open style ${pad2(index + 1)}, ${style.name}`);

    const frame = el('span', 'tile-frame');
    const canvas = el('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    frame.appendChild(canvas);

    const caption = el('span', 'caption');
    caption.append(
      el('span', 'num', pad2(index + 1)),
      el('span', 'name', style.name),
      el('span', 'blurb', style.blurb),
    );

    button.append(frame, caption);
    grid.appendChild(button);
    button.addEventListener('click', () => openViewer(index));
    return { index, style, button, canvas, ctx: canvas.getContext('2d'), visible: false, dirty: true };
  });

  // ---- viewer ------------------------------------------------------------
  const viewer = el('div', 'viewer');
  viewer.hidden = true;
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', 'Style viewer');

  const info = el('div', 'viewer-info');
  const vNum = el('span', 'num');
  const vName = el('span', 'name');
  const vBlurb = el('span', 'blurb');
  info.append(vNum, vName, vBlurb);

  const top = el('div', 'viewer-top');
  const closeBtn = el('button', 'close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close viewer');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>';
  closeBtn.addEventListener('click', () => closeViewer());
  top.append(createSeg(), closeBtn);

  viewer.append(info, top);

  appRoot.append(header, main, viewer);

  let viewerIndex = -1;
  let viewerOpenedAt = 0;

  function showViewerInfo(): void {
    const s = styles[viewerIndex];
    if (!s) return;
    vNum.textContent = pad2(viewerIndex + 1);
    vName.textContent = s.name;
    vBlurb.textContent = s.blurb;
  }

  function openViewer(index: number): void {
    viewerIndex = index;
    viewerOpenedAt = performance.now();
    viewer.hidden = false;
    viewer.insertBefore(stage.canvas, viewer.firstChild);
    document.body.classList.add('viewer-open');
    showViewerInfo();
    closeBtn.focus();
  }

  function closeViewer(): void {
    if (viewerIndex < 0) return;
    const tile = tiles[viewerIndex];
    viewerIndex = -1;
    if (stage.canvas.parentNode === viewer) viewer.removeChild(stage.canvas);
    viewer.hidden = true;
    document.body.classList.remove('viewer-open');
    for (const t of tiles) t.dirty = true;
    if (tile) tile.button.focus();
  }

  function stepViewer(delta: number): void {
    if (viewerIndex < 0) return;
    const n = styles.length;
    viewerIndex = (viewerIndex + delta + n) % n;
    viewerOpenedAt = performance.now();
    showViewerInfo();
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'Escape':
        if (viewerIndex >= 0) {
          e.preventDefault();
          closeViewer();
        }
        break;
      case 'ArrowLeft':
        if (viewerIndex >= 0) {
          e.preventDefault();
          stepViewer(-1);
        }
        break;
      case 'ArrowRight':
        if (viewerIndex >= 0) {
          e.preventDefault();
          stepViewer(1);
        }
        break;
      case '1':
      case '2':
      case '3':
        setTarget(Number(e.key) - 1);
        break;
      default:
        break;
    }
  });

  // ---- visibility and resize --------------------------------------------
  const tileByCanvas = new Map<Element, Tile>();
  for (const t of tiles) tileByCanvas.set(t.button, t);

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const t = tileByCanvas.get(entry.target);
        if (!t) continue;
        if (entry.isIntersecting && !t.visible) t.dirty = true;
        t.visible = entry.isIntersecting;
      }
    },
    { rootMargin: '120px 0px' },
  );
  for (const t of tiles) io.observe(t.button);

  const ro = new ResizeObserver(() => {
    for (const t of tiles) t.dirty = true;
  });
  ro.observe(grid);
  window.addEventListener('resize', () => {
    for (const t of tiles) t.dirty = true;
  });

  // ---- painting ----------------------------------------------------------
  function dpr(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  function paintTile(t: Tile, time: number): void {
    const ctx = t.ctx;
    if (!ctx) return;
    const k = dpr();
    const w = Math.max(1, Math.round(t.canvas.clientWidth * k));
    const h = Math.max(1, Math.round(t.canvas.clientHeight * k));
    if (t.canvas.width !== w) t.canvas.width = w;
    if (t.canvas.height !== h) t.canvas.height = h;
    stage.render(t.style, tod, time, w, h);
    ctx.drawImage(stage.canvas, 0, 0);
    t.dirty = false;
  }

  let cursor = 0;

  function paintTiles(time: number, frameStart: number): void {
    let painted = 0;
    const budgetLeft = (): boolean => performance.now() - frameStart < FRAME_BUDGET_MS;

    // Tiles that have never been painted or need a repaint come first.
    for (const t of tiles) {
      if (painted >= MAX_PER_FRAME) return;
      if (!t.visible || !t.dirty) continue;
      if (painted >= MIN_PER_FRAME && !budgetLeft()) return;
      paintTile(t, time);
      painted++;
    }

    // Then round-robin over visible tiles.
    const n = tiles.length;
    for (let step = 0; step < n && painted < MAX_PER_FRAME; step++) {
      if (painted >= MIN_PER_FRAME && !budgetLeft()) break;
      const t = tiles[cursor % n];
      cursor = (cursor + 1) % n;
      if (!t || !t.visible) continue;
      paintTile(t, time);
      painted++;
    }
  }

  // ---- main loop ---------------------------------------------------------
  let last = performance.now();

  function frame(now: number): void {
    const frameStart = performance.now();
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    last = now;

    if (tod !== target) {
      tod += (target - tod) * (1 - Math.exp(-dt * 3));
      if (Math.abs(target - tod) < 0.001) tod = target;
    }

    const time = now / 1000;

    if (viewerIndex >= 0) {
      const style = styles[viewerIndex];
      if (style) {
        const k = dpr();
        const w = Math.max(1, Math.round(window.innerWidth * k));
        const h = Math.max(1, Math.round(window.innerHeight * k));
        stage.render(style, tod, time, w, h, (now - viewerOpenedAt) / 1000);
      }
    } else {
      paintTiles(time, frameStart);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
