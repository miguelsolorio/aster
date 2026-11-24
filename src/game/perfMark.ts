// A section timer any system can call; it does nothing unless the ?perf overlay is on (perfHud.ts
// installs the real one). Time since the previous mark is charged to the label.
let markFn: ((label: string) => void) | null = null;

export function perfMark(label: string): void {
  markFn?.(label);
}

export function setPerfMark(fn: ((label: string) => void) | null): void {
  markFn = fn;
}
