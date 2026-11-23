// Plans a city off the main thread (see planAhead.ts), and works out what the page would make of
// the plan next: the geometry of its buildings and the buildings' part of its ground shade. All of
// it is plain data worked out from the site alone, so it comes out the same here as on the page.
import { cityData, cityDataBuffers } from './build';
import { contactBase, roofBytes } from './contactShade';
import { planCity } from './plan';
import type { CitySite } from './types';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CitySite>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const plan = planCity(e.data);
  const data = cityData(plan);
  const shade = contactBase(plan.grid, plan.gridSize);
  const roof = roofBytes(plan.grid, shade);
  const transfer = new Set<ArrayBuffer>([plan.grid.buffer as ArrayBuffer, plan.roomOf.buffer as ArrayBuffer, shade.buffer as ArrayBuffer, roof.buffer as ArrayBuffer, ...cityDataBuffers(data)]);
  scope.postMessage({ id: e.data.id, plan, prep: { data, shade, roof } }, [...transfer]);
};
