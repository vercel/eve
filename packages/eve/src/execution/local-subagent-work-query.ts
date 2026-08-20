import { getRun } from "#internal/workflow/runtime.js";
import { findRunningAgentHandle } from "#harness/handles/query.js";
import type { WorkGraph } from "#harness/work-graph.js";
import type { SessionStateMap } from "#harness/types.js";

export const LOCAL_SUBAGENT_WORK_NAMESPACE = "eve.work";

export type LocalSubagentWorkQueryResult =
  | { readonly kind: "available"; readonly revision: number; readonly work: WorkGraph }
  | {
      readonly kind: "unavailable";
      readonly reason: "not-local" | "not-running" | "not-yet-committed";
    };

/** Reads the latest committed work graph for one direct running local subagent. */
export async function readLocalSubagentWork(input: {
  readonly callId: string;
  readonly parentState: SessionStateMap | undefined;
}): Promise<LocalSubagentWorkQueryResult> {
  const handle = findRunningAgentHandle(input.parentState, { callId: input.callId });
  if (handle === undefined) return { kind: "unavailable", reason: "not-running" };
  if (handle.address.kind !== "agent/local") return { kind: "unavailable", reason: "not-local" };

  const reader = getRun(handle.address.sessionId)
    .getReadable<unknown>({ namespace: LOCAL_SUBAGENT_WORK_NAMESPACE, startIndex: -1 })
    .getReader();
  try {
    const next = await reader.read();
    const work = parseWorkGraph(next.value);
    return work === undefined
      ? { kind: "unavailable", reason: "not-yet-committed" }
      : { kind: "available", revision: work.revision, work };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseWorkGraph(value: unknown): WorkGraph | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const work = value as Partial<WorkGraph>;
  return typeof work.revision === "number" && Number.isSafeInteger(work.revision)
    ? (work as WorkGraph)
    : undefined;
}
