import { defineState } from "#public/context/index.js";

export const budget = defineState("compatibility.budget", () => ({
  count: 0,
  limit: 10,
}));

export function recordUsage(): void {
  budget.update((current) => ({ ...current, count: current.count + 1 }));
}
