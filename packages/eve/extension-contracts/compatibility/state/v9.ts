import { defineState } from "#public/context/index.js";

export const visits = defineState("compatibility.visits", () => ({ count: 0 }));
export function recordVisit(): number {
  visits.update((current) => ({ count: current.count + 1 }));
  return visits.get().count;
}
