// Looking through the spyglass: the view closes down to a round of glass in the dark of the
// tube, with a small ring at its centre that draws itself closed while a far place is held
// steady in it.
import './spyglass.css';

export class SpyglassView {
  private readonly root: HTMLElement;
  private readonly arc: SVGCircleElement;
  private shown = 0;
  private prog = -1;

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'aster-glass';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="aster-glass__tube"></div><div class="aster-glass__rim"></div>' +
      '<svg class="aster-glass__mark" viewBox="-20 -20 40 40"><circle class="aster-glass__ring" r="13"/><circle class="aster-glass__arc" r="13" pathLength="100"/><circle class="aster-glass__dot" r="0.9"/></svg>';
    host.appendChild(root);
    this.root = root;
    this.arc = root.querySelector('.aster-glass__arc') as SVGCircleElement;
  }

  /** k: 0 lowered .. 1 at the eye. progress: 0..1 of a sighting being held, or 0 for none. */
  set(k: number, progress: number): void {
    const s = Math.round(k * 100) / 100;
    if (s !== this.shown) {
      this.shown = s;
      this.root.style.display = s > 0 ? 'block' : 'none';
      this.root.style.setProperty('--k', String(s));
    }
    const p = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (p !== this.prog) {
      this.prog = p;
      this.arc.style.strokeDasharray = `${p} 100`;
      this.root.classList.toggle('is-sighting', p > 0);
    }
  }
}
