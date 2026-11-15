// Sleeping at the bedroll: a small choice of when to wake, then the dark of the night (or the
// day) passing, and the desert again in different light.
import './sleep.css';

export type Wake = 'dawn' | 'dusk';
const WAKES: Wake[] = ['dawn', 'dusk'];

export class SleepView {
  private readonly ask: HTMLElement;
  private readonly dark: HTMLElement;
  private readonly opts: HTMLButtonElement[] = [];
  private readonly hint: HTMLElement;
  private sel = 0;
  private timers: number[] = [];
  isOpen = false;
  /** The eyes are closed (or closing, or opening): nothing else should happen meanwhile. */
  asleep = false;

  constructor(
    host: HTMLElement,
    private readonly onChoose: (to: Wake) => void,
  ) {
    const ask = document.createElement('div');
    ask.className = 'aster-sleep';
    ask.setAttribute('role', 'dialog');
    ask.setAttribute('aria-label', 'Sleep until');
    const label = document.createElement('span');
    label.className = 'aster-sleep__label';
    label.textContent = 'Sleep until';
    ask.append(label);
    WAKES.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'aster-sleep__opt';
      b.textContent = w === 'dawn' ? 'Dawn' : 'Dusk';
      b.addEventListener('click', () => {
        this.sel = i;
        this.confirm();
      });
      this.opts.push(b);
      ask.append(b);
    });
    this.hint = document.createElement('span');
    this.hint.className = 'aster-sleep__hint';
    ask.append(this.hint);
    const dark = document.createElement('div');
    dark.className = 'aster-sleep-dark';
    dark.setAttribute('aria-hidden', 'true');
    host.append(dark, ask);
    this.ask = ask;
    this.dark = dark;
  }

  /** Ask when to wake. `first` is the one offered: whichever comes next. */
  open(first: Wake, touch: boolean): void {
    if (this.asleep) return;
    this.isOpen = true;
    this.sel = WAKES.indexOf(first);
    this.hint.textContent = touch ? '' : 'A D to choose · E to sleep · Esc to stay up';
    this.ask.classList.add('is-on');
    this.paint();
  }

  close(): void {
    this.isOpen = false;
    this.ask.classList.remove('is-on');
  }

  move(dir: number): void {
    if (!this.isOpen) return;
    this.sel = Math.min(WAKES.length - 1, Math.max(0, this.sel + dir));
    this.paint();
  }

  confirm(): void {
    if (!this.isOpen) return;
    const to = WAKES[this.sel];
    this.close();
    this.asleep = true;
    this.dark.classList.add('is-on');
    // eyes closed: the hours pass in the dark, and then they open
    this.timers.push(
      window.setTimeout(() => this.onChoose(to), 1300),
      window.setTimeout(() => this.dark.classList.remove('is-on'), 2100),
      window.setTimeout(() => (this.asleep = false), 3300),
    );
  }

  private paint(): void {
    this.opts.forEach((b, i) => b.classList.toggle('is-sel', i === this.sel));
  }
}
