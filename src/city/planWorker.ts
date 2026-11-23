// Plans a city off the main thread (see planAhead.ts), and works out what the page would make of
// the plan next: the geometry of its buildings and the buildings' part of its ground shade. All of
// it is plain data worked out from the site alone, so it comes out the same here as on the page.
// The modelled details (the kit, loaded on the page) are sent over once they have arrived; a city
// worked out before that is sent its details alone when asked.
import { type ArchKit, cityData, cityDataBuffers, detailData } from './build';
import { contactBase, roofBytes } from './contactShade';
import { planCity } from './plan';
import type { CitySite } from './types';

type Message = CitySite | { type: 'kit'; kit: ArchKit } | { type: 'details'; site: CitySite };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Message>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

let kit: ArchKit | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if ('type' in m) {
    if (m.type === 'kit') kit = m.kit;
    else if (kit) {
      const details = detailData(planCity(m.site), kit);
      scope.postMessage({ id: m.site.id, details }, cityDataBuffers({ detail: details.detail }));
    }
    return;
  }
  const plan = planCity(m);
  const data = cityData(plan, kit);
  const shade = contactBase(plan.grid, plan.gridSize);
  const roof = roofBytes(plan.grid, shade);
  const transfer = new Set<ArrayBuffer>([plan.grid.buffer as ArrayBuffer, plan.roomOf.buffer as ArrayBuffer, shade.buffer as ArrayBuffer, roof.buffer as ArrayBuffer, ...cityDataBuffers(data)]);
  scope.postMessage({ id: m.id, plan, prep: { data, shade, roof } }, [...transfer]);
};
