import * as THREE from 'three';
import './talk.css';

// Talking. Anyone within reach gets a faint mark over their head; the interact key
// starts a conversation, steps through its lines, and ends it. Walking away ends it too.
// The lines are drawn in the page, over the scene, anchored to the speaker's head.

/** Someone who can be spoken to, as the systems that own them describe them. */
export interface Speaker {
  kind: 'traveller' | 'pilgrim' | 'keeper' | 'herder' | 'townsfolk' | 'miner';
  /** Whatever the owning system needs to find this person again. */
  ref: unknown;
  /** Head position in the world. */
  x: number;
  y: number;
  z: number;
  /** Voice pitch in Hz. */
  pitch: number;
}

export interface Script {
  lines: string[];
  /** Called when the last line has been read. */
  done?: () => void;
}

export interface TalkHooks {
  /** The nearest person within reach of the player, or null. */
  find(out: Speaker): boolean;
  /** Keep the speaker facing the player and refresh their position. False if they are gone. */
  hold(s: Speaker): boolean;
  /** What this person has to say right now. */
  script(s: Speaker): Script;
  /** A line has just appeared. */
  voice(pitch: number): void;
}

const LEAVE = 5.5; // metres: further than this from the speaker and the conversation is over

export class Talk {
  /** Someone is in reach, or a conversation is under way (drives the touch button). */
  available = false;

  private readonly layer: HTMLDivElement;
  private readonly cue: HTMLDivElement;
  private readonly dig: HTMLDivElement;
  private readonly say: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly more: HTMLSpanElement;
  private readonly near: Speaker = { kind: 'townsfolk', ref: null, x: 0, y: 0, z: 0, pitch: 200 };
  private readonly who: Speaker = { kind: 'townsfolk', ref: null, x: 0, y: 0, z: 0, pitch: 200 };
  private hasNear = false;
  /** A short line over a point, outside any conversation: where, and until when (ms). */
  private note: { x: number; y: number; z: number } | null = null;
  private noteUntil = 0;
  private script: Script | null = null;
  private line = 0;
  private readonly v = new THREE.Vector3();

  constructor(host: HTMLElement, private readonly hooks: TalkHooks) {
    const layer = document.createElement('div');
    layer.className = 'aster-talk';
    this.cue = document.createElement('div');
    this.cue.className = 'aster-talk__cue';
    this.say = document.createElement('div');
    this.say.className = 'aster-talk__say';
    this.say.setAttribute('role', 'status');
    this.say.setAttribute('aria-live', 'polite');
    this.text = document.createElement('span');
    this.more = document.createElement('span');
    this.more.className = 'aster-talk__more';
    this.more.setAttribute('aria-hidden', 'true');
    this.say.append(this.text, this.more);
    // the same key cap, over a place in the sand worth striking
    this.dig = document.createElement('div');
    this.dig.className = 'aster-talk__cue';
    layer.append(this.cue, this.dig, this.say);
    host.prepend(layer);
    this.layer = layer;
  }

  /** The key that talks, shown over anyone in reach. Empty on touch, where a button appears instead. */
  setKey(label: string): void {
    if (this.cue.textContent === label) return;
    this.cue.textContent = label;
    this.cue.classList.toggle('aster-talk__cue--key', label !== '');
    this.dig.textContent = label;
    this.dig.classList.toggle('aster-talk__cue--key', label !== '');
  }

  /** Show the key cap over a spot on the ground (somewhere to dig), or hide it. Call once a frame, after update. */
  mark(camera: THREE.PerspectiveCamera, at: { x: number; y: number; z: number } | null): void {
    const on = at !== null && !this.talking && !this.hasNear;
    this.dig.classList.toggle('is-on', on);
    if (on && at) this.place(this.dig, camera, at, 0, false);
  }

  get talking(): boolean {
    return this.script !== null;
  }

  /** Where the person being spoken to stands (valid while talking). */
  get speaker(): Speaker {
    return this.who;
  }

  /** The bubble takes the look's ink and paper, as long as the two can be told apart. */
  setColours(ink: THREE.Vector3, paper: THREE.Vector3): void {
    const lum = (c: THREE.Vector3) => 0.3 * c.x + 0.59 * c.y + 0.11 * c.z;
    const css = (c: THREE.Vector3) => `rgb(${Math.round(c.x * 255)}, ${Math.round(c.y * 255)}, ${Math.round(c.z * 255)})`;
    const ok = Math.abs(lum(ink) - lum(paper)) > 0.45;
    this.layer.style.setProperty('--say-ink', ok ? css(ink) : '#1a1410');
    this.layer.style.setProperty('--say-paper', ok ? css(paper) : '#f4ecdc');
  }

  /** The interact key: start talking to whoever is in reach, or move on to the next line. */
  interact(): void {
    if (this.script) {
      this.line++;
      if (this.line >= this.script.lines.length) {
        const done = this.script.done;
        this.end();
        done?.();
      } else this.show();
      return;
    }
    if (!this.hasNear) return;
    Object.assign(this.who, this.near);
    const s = this.hooks.script(this.who);
    if (!s.lines.length) return;
    this.script = s;
    this.line = 0;
    this.show();
  }

  /** Say one line over a point for a few seconds (the stone waking), with no one to talk to. */
  tell(at: { x: number; y: number; z: number }, line: string, seconds = 4.5): void {
    this.note = { x: at.x, y: at.y, z: at.z };
    this.noteUntil = performance.now() + seconds * 1000;
    this.text.textContent = line;
    this.more.style.display = 'none';
  }

  /** A line from `tell` is still up. */
  get telling(): boolean {
    return this.note !== null && performance.now() < this.noteUntil;
  }

  end(): void {
    this.script = null;
    this.say.classList.remove('is-on');
  }

  /** Once a frame. `active` is false whenever the game is not being played. */
  update(camera: THREE.PerspectiveCamera, px: number, pz: number, active: boolean): void {
    if (!active) {
      this.cue.classList.remove('is-on');
      this.say.classList.remove('is-on');
      this.available = this.talking;
      return;
    }
    if (this.script) {
      const here = this.hooks.hold(this.who);
      if (!here || Math.hypot(this.who.x - px, this.who.z - pz) > LEAVE) this.end();
    }
    if (this.script) {
      this.cue.classList.remove('is-on');
      this.say.classList.add('is-on');
      this.place(this.say, camera, this.who, 0.32, true);
    } else {
      this.hasNear = this.hooks.find(this.near);
      this.cue.classList.toggle('is-on', this.hasNear);
      if (this.hasNear) this.place(this.cue, camera, this.near, 0.34, false);
      const noted = this.telling;
      this.say.classList.toggle('is-on', noted);
      if (noted && this.note) this.place(this.say, camera, this.note, 0.32, true);
    }
    this.available = this.talking || this.hasNear;
  }

  private show(): void {
    const s = this.script;
    if (!s) return;
    this.text.textContent = s.lines[this.line];
    this.more.style.display = this.line < s.lines.length - 1 ? '' : 'none';
    this.hooks.voice(this.who.pitch);
  }

  /** Put an element over a head. A bubble sits above the point and stays on screen. */
  private place(el: HTMLElement, camera: THREE.PerspectiveCamera, s: { x: number; y: number; z: number }, lift: number, bubble: boolean): void {
    const v = this.v.set(s.x, s.y + lift, s.z).project(camera);
    if (v.z > 1 || v.z < -1) {
      el.style.opacity = '0';
      return;
    }
    el.style.opacity = '';
    const w = window.innerWidth;
    const h = window.innerHeight;
    let x = (v.x * 0.5 + 0.5) * w;
    let y = (-v.y * 0.5 + 0.5) * h;
    if (bubble) {
      // The bubble is a caption in a fixed place near the top of the screen, so a close or
      // crowded view never hides it. Its tail points down at the speaker when they are below it.
      const bw = el.offsetWidth;
      const bh = el.offsetHeight;
      const top = Math.round(Math.max(56, h * 0.1));
      const left = Math.round((w - bw) / 2);
      el.style.transform = `translate(${left}px, ${top}px)`;
      const tail = Math.min(bw - 20, Math.max(20, x - left));
      el.style.setProperty('--tail-x', `${Math.round(tail)}px`);
      el.classList.toggle('has-tail', y > top + bh + 24);
    } else {
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
