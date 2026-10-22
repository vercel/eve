// Epoch 14 of the state capability. Epoch 15 changes only the sandbox session types it reaches
// (eve-owned declarations plus `writeFiles`); state authoring is unchanged, as this example shows.
import { defineState } from "#public/context/index.js";

export const visits = defineState("compatibility.visits", () => ({ count: 0, visitor: "Alice" }));
export function recordVisit(): number {
  visits.update((current) => ({ ...current, count: current.count + 1 }));
  return visits.get().count;
}
