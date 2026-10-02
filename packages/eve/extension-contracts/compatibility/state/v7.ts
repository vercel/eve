import { defineState } from "#public/context/index.js";

// Epoch 7 state callers could reach ctx.getSkill() through session context;
// state handles are unchanged.
export const visits = defineState("compatibility.visits", () => ({ count: 0 }));

export function recordVisit(): number {
  visits.update((current) => ({ count: current.count + 1 }));
  return visits.get().count;
}
