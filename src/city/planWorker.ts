// Plans a city off the main thread (see planAhead.ts). A plan is plain data worked out from the
// site alone, so it comes out the same here as it would on the page.
import { planCity } from './plan';
import type { CitySite } from './types';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CitySite>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const plan = planCity(e.data);
  scope.postMessage({ id: e.data.id, plan }, [plan.grid.buffer as ArrayBuffer, plan.roomOf.buffer as ArrayBuffer]);
};
