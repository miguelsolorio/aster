// Builds a deep off the main thread (see deepAhead.ts). A deep's data is worked out from its spec
// alone, so it comes out the same here as it would on the page; its arrays are handed back, not
// copied.
import { createDeepData, deepBuffers } from './data';
import type { DeepData } from './builder';
import type { DeepAsk, DeepAnswer } from './deepAhead';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DeepAsk>) => void) | null;
  postMessage(message: DeepAnswer, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, spec } = e.data;
  let data: DeepData;
  try {
    data = createDeepData(spec);
  } catch {
    scope.postMessage({ id, data: null });
    return;
  }
  scope.postMessage({ id, data }, deepBuffers(data));
};
