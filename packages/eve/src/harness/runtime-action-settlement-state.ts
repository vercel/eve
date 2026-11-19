import { ContextKey } from "#context/key.js";

export const RuntimeActionSettlementTimesKey = new ContextKey<Readonly<Record<string, number>>>(
  "eve.harness.runtimeActionSettlementTimes",
);
