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
  pendingObservations?: Observation[];
}>("feedback-scope", () => ({
  current: null,
  previous: null,
  currentTargets: [],
  previousTargets: [],
  pendingObservations: [],
}));

export function pseudonym(c: Config, value: string): string {
  return createHmac("sha256", hmacSecret(c)).update(value).digest("hex").slice(0, 32);
}
export function fingerprint(c: Config, input: unknown): string {
  return pseudonym(c, JSON.stringify(input) ?? "undefined");
}
export function pseudonymizeObservation(
  c: Config,
  value: Omit<Observation, "session" | "turn" | "principal"> & {
    session: string;
    turn: string;
    principal: string;
  },
): Observation {
  return {
    ...value,
    id: pseudonym(c, value.id),
    session: pseudonym(c, value.session),
    turn: pseudonym(c, value.turn),
    principal: pseudonym(c, value.principal),
  };
}
export async function observe(
  c: Config,
  value: Omit<Observation, "session" | "turn" | "principal"> & {
    session: string;
    turn: string;
    principal: string;
  },
): Promise<void> {
  await store(c).observe(pseudonymizeObservation(c, value));
}
export type ObserveBatchResult = "ok" | "aborted" | "failed";

function awaitChunkWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ readonly aborted: true } | { readonly aborted: false; readonly value: T }> {
  if (signal === undefined) return work.then((value) => ({ aborted: false as const, value }));
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.resolve({ aborted: true as const });
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void work.catch(() => {});
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function observeBatch(
  c: Config,
  samples: readonly Observation[],
  options: { readonly concurrency?: number; readonly signal?: AbortSignal } = {},
): Promise<ObserveBatchResult> {
  if (samples.length === 0) return "ok";
  const concurrency = options.concurrency ?? 8;
  const backend = store(c);
  let failed = false;
  for (let i = 0; i < samples.length; i += concurrency) {
    if (options.signal?.aborted) return failed ? "failed" : "aborted";
    const chunk = samples.slice(i, i + concurrency);
    const settled = await awaitChunkWithSignal(
      Promise.allSettled(chunk.map((sample) => backend.observe(sample))),
      options.signal,
    );
    if (settled.aborted) return failed ? "failed" : "aborted";
    const rejected = settled.value.filter((result) => result.status === "rejected").length;
    if (rejected > 0) failed = true;
    if (rejected === chunk.length) break;
  }
  return failed ? "failed" : "ok";
}
