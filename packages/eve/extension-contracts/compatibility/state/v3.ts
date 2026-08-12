import { defineState } from "#public/context/index.js";

export const lastObservedNetworkPolicy = defineState<string | null>(
  "compatibility.lastObservedNetworkPolicy",
  () => null,
);

export function recordNetworkPolicy(policy: string): void {
  lastObservedNetworkPolicy.update(() => policy);
}
