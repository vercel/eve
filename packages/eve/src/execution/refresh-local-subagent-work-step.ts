import { deserializeContext, serializeContext } from "#context/serialize.js";
import { WorkGraphKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { readLocalSubagentWork } from "#execution/local-subagent-work-query.js";
import { findRunningLocalAgentHandles } from "#harness/handles/query.js";
import { adoptChildWorkSnapshot } from "#harness/work-graph.js";

/** Pulls newer direct local-subagent work snapshots into a parent work graph. */
export async function refreshLocalSubagentWorkStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly serializedContext: Record<string, unknown> }> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  let work = ctx.get(WorkGraphKey);
  if (work === undefined) return { serializedContext: input.serializedContext };

  const handles = findRunningLocalAgentHandles(input.sessionState.snapshot?.session.state);
  for (const handle of handles) {
    const child = await readLocalSubagentWork({
      callId: handle.operation.callId,
      parentState: input.sessionState.snapshot?.session.state,
    });
    if (child.kind !== "available") continue;
    work = adoptChildWorkSnapshot(work, {
      callId: handle.operation.callId,
      sessionId: handle.address.sessionId,
      snapshot: child.work,
    });
  }

  if (work === ctx.get(WorkGraphKey)) return { serializedContext: input.serializedContext };
  ctx.set(WorkGraphKey, work);
  return { serializedContext: serializeContext(ctx) };
}
