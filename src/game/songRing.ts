// The ring of songs: held open while the flute is held, to choose which to play. A thin circle
// of ink in the middle of the view with a mark for each song known, the chosen one named at its
// centre. No box, like the compass. With a mouse the pointer is locked in play, so it is steered
// by the way the mouse moves; on touch each mark is tapped.
import { SONGS, SONG_NAMES, type Song } from './songs';
import './songRing.css';

const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body: string) => `<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false" ${S}>${body}</svg>`;

/** One small drawing per song, in the same line as the touch buttons. */
const GLYPHS: Record<Song, string> = {
  // a pair of long horns: what comes when it is played
  call: svg('<path d="M12.500 22C11 15 8.500 9.500 5 5.500"/><path d="M15.500 22C17 15 19.500 9.500 23 5.500"/><path d="M11 22.500h6"/>'),
  // three stones standing, the middle one tallest
  waking: svg('<path d="M5.500 22.500v-8.500a2 2 0 0 1 4 0v8.500"/><path d="M12 22.500V7.500a2 2 0 0 1 4 0v15"/><path d="M18.500 22.500v-6.500a2 2 0 0 1 4 0v6.500"/><path d="M3.500 22.500h21"/>'),
  // air, going somewhere
  wind: svg('<path d="M4 10.500h11.500a3 3 0 1 0-3-3"/><path d="M4 15h17a3 3 0 1 1-3 3"/><path d="M4 19.500h7.500"/>'),
  // a cloud and what falls from it
  rain: svg('<path d="M8 15.500a4.500 4.500 0 0 1 .7-8.950a6 6 0 0 1 11.300 1.700A3.700 3.700 0 0 1 19.500 15.500z"/><path d="M9.500 19v3"/><path d="M14 19.500v3.500"/><path d="M18.500 19v3"/>'),
  // ground split open, and light coming up through it
  opening: svg('<path d="M3.500 19.500h6l2.500-3 2 4.500 2.500-5 2 3.500h6"/><path d="M14 11.500V5"/><path d="M9 12.500 6.500 8"/><path d="M19 12.500 21.500 8"/>'),
};

/** Where each song sits: clockwise from the top, a fifth of the way round apiece. */
const angleOf = (s: Song): number => (SONGS.indexOf(s) / SONGS.length) * Math.PI * 2;

export class SongRing {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly marks = new Map<Song, HTMLButtonElement>();
  private known: readonly Song[] = [];
  private chosen: Song = 'call';
  private ax = 0;
  private ay = 0;
  private open_ = false;

  /** onChoose is only used on touch: a tap on a song (or outside: null) closes the ring and reports the choice. */
  constructor(
    host: HTMLElement,
    private readonly onChoose: (s: Song | null) => void,
  ) {
    const root = document.createElement('div');
    root.className = 'aster-songs';
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', 'Songs');
    root.setAttribute('aria-hidden', 'true');
    const ring = document.createElement('div');
    ring.className = 'aster-songs__ring';
    for (const s of SONGS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'aster-songs__mark';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', SONG_NAMES[s]);
      b.tabIndex = -1;
      b.innerHTML = GLYPHS[s];
      const a = angleOf(s);
      b.style.setProperty('--x', Math.sin(a).toFixed(4));
      b.style.setProperty('--y', (-Math.cos(a)).toFixed(4));
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (!this.open_ || !this.known.includes(s)) return;
        this.select(s);
        this.finish(s);
      });
      this.marks.set(s, b);
      ring.appendChild(b);
    }
    this.name = document.createElement('div');
    this.name.className = 'aster-songs__name';
    ring.appendChild(this.name);
    root.appendChild(ring);
    // a tap anywhere else puts it away
    root.addEventListener('pointerdown', () => {
      if (this.open_ && root.classList.contains('is-touch')) this.finish(null);
    });
    host.appendChild(root);
    this.root = root;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(known: readonly Song[], current: Song, touch: boolean): void {
    this.known = known;
    this.ax = this.ay = 0;
    for (const [s, b] of this.marks) b.classList.toggle('is-known', known.includes(s));
    this.select(known.includes(current) ? current : (known[0] ?? 'call'));
    this.root.classList.toggle('is-touch', touch);
    this.root.classList.add('is-on');
    this.root.setAttribute('aria-hidden', 'false');
    this.open_ = true;
  }

  /** Mouse movement while open (the pointer is locked in play): steers the selection. */
  move(dx: number, dy: number): void {
    if (!this.open_) return;
    // The movement gathers into a lean away from the middle, never further than the ring is
    // wide, so a turn the other way is felt at once.
    this.ax += dx;
    this.ay += dy;
    const len = Math.hypot(this.ax, this.ay);
    const MAX = 70;
    if (len > MAX) {
      this.ax *= MAX / len;
      this.ay *= MAX / len;
    }
    if (len < 16) return;
    const a = Math.atan2(this.ax, -this.ay);
    let best: Song | null = null;
    let bd = Infinity;
    for (const s of this.known) {
      const d = Math.abs(Math.atan2(Math.sin(a - angleOf(s)), Math.cos(a - angleOf(s))));
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best && best !== this.chosen) this.select(best);
  }

  /** Keys 1..5 while open choose by position among the known songs. */
  key(n: number): void {
    if (!this.open_) return;
    const s = this.known[n - 1];
    if (s) this.select(s);
  }

  /** Close it. Returns the song selected, or null if it was not open. */
  close(): Song | null {
    if (!this.open_) return null;
    this.open_ = false;
    this.root.classList.remove('is-on');
    this.root.setAttribute('aria-hidden', 'true');
    return this.chosen;
  }

  private finish(s: Song | null): void {
    this.close();
    this.onChoose(s);
  }

  private select(s: Song): void {
    this.chosen = s;
    for (const [k, b] of this.marks) {
      const on = k === s;
      b.classList.toggle('is-chosen', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    this.name.textContent = SONG_NAMES[s];
  }
}
