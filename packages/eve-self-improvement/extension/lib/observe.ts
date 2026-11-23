import { createHmac } from "node:crypto";
import { defineState } from "eve/context";
import { hmacSecret, type Config } from "./config.js";
import { store } from "./store.js";
import type { Observation } from "./types.js";

export const feedbackScope = defineState<{
  current: string | null;
  previous: string | null;
  currentTargets: string[];
  previousTargets: string[];
}>("feedback-scope", () => ({
  current: null,
  previous: null,
  currentTargets: [],
  previousTargets: [],
}));

export function pseudonym(c: Config, value: string): string {
  return createHmac("sha256", hmacSecret(c)).update(value).digest("hex").slice(0, 32);
}
export function fingerprint(c: Config, input: unknown): string {
  return pseudonym(c, JSON.stringify(input) ?? "undefined");
}
export async function observe(
  c: Config,
  value: Omit<Observation, "session" | "turn" | "principal"> & {
    session: string;
    turn: string;
    principal: string;
  },
): Promise<void> {
  await store(c).observe({
    ...value,
    id: pseudonym(c, value.id),
    session: pseudonym(c, value.session),
    turn: pseudonym(c, value.turn),
    principal: pseudonym(c, value.principal),
  });
}
