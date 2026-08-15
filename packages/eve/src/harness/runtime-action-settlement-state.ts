import { ContextKey } from "#context/key.js";

/** Per-call acceptance times ferried through one internal turn step. */
export const RuntimeActionSettlementTimesKey = new ContextKey<Readonly<Record<string, number>>>(
  "eve.harness.runtimeActionSettlementTimes",
);
