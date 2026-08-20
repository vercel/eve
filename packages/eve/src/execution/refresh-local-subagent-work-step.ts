import { buildAdapterContext } from "#channel/adapter-context.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { WorkGraphKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { readLocalSubagentWork } from "#execution/local-subagent-work-query.js";
import { findRunningLocalAgentHandles } from "#harness/handles/query.js";
import { adoptChildWorkSnapshot } from "#harness/work-graph.js";

/** Pulls newer direct local-subagent work snapshots into a parent work graph. */
export async function refreshLocalSubagentWorkStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly hasRunningLocalSubagents: boolean;
  readonly poll: {
    readonly adoptedCallIds: readonly string[];
    readonly childWork: readonly {
      readonly callId: string;
      readonly outcome: "available" | "not-local" | "not-running" | "not-yet-committed";
      readonly revision?: number;
    }[];
    readonly rendered: boolean;
    readonly workRevision: number;
  };
  readonly serializedContext: Record<string, unknown>;
}> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  let work = ctx.get(WorkGraphKey);
  if (work === undefined) {
    return {
      hasRunningLocalSubagents: false,
      poll: { adoptedCallIds: [], childWork: [], rendered: false, workRevision: 0 },
      serializedContext: input.serializedContext,
    };
  }

  const handles = findRunningLocalAgentHandles(input.sessionState.snapshot?.session.state);
  const childWork: {
    callId: string;
    outcome: "available" | "not-local" | "not-running" | "not-yet-committed";
    revision?: number;
  }[] = [];
  const adoptedCallIds: string[] = [];
  console.error("[eve.work] querying direct local subagents", {
    callIds: handles.map((handle) => handle.operation.callId),
    parentSessionId: input.sessionState.sessionId,
  });
  let allChildrenTerminal = handles.length > 0;
  for (const handle of handles) {
    const child = await readLocalSubagentWork({
      callId: handle.operation.callId,
      parentState: input.sessionState.snapshot?.session.state,
    });
    console.error("[eve.work] local subagent work query", {
      callId: handle.operation.callId,
      childSessionId: handle.address.sessionId,
      outcome: child.kind === "available" ? `available:${child.revision}` : child.reason,
      parentSessionId: input.sessionState.sessionId,
    });
    if (child.kind !== "available") {
      childWork.push({ callId: handle.operation.callId, outcome: child.reason });
      allChildrenTerminal = false;
      continue;
    }
    childWork.push({
      callId: handle.operation.callId,
      outcome: "available",
      revision: child.revision,
    });
    if (
      child.work.turn === undefined ||
      !["completed", "failed", "cancelled"].includes(child.work.turn.phase)
    ) {
      allChildrenTerminal = false;
    }
    const priorRevision = work.revision;
    work = adoptChildWorkSnapshot(work, {
      callId: handle.operation.callId,
      sessionId: handle.address.sessionId,
      snapshot: child.work,
    });
    if (work.revision !== priorRevision) adoptedCallIds.push(handle.operation.callId);
    console.error("[eve.work] local subagent work adoption", {
      callId: handle.operation.callId,
      childRevision: child.revision,
      parentRevision: work.revision,
      parentRevisionBefore: priorRevision,
    });
  }

  if (work === ctx.get(WorkGraphKey)) {
    console.error("[eve.work] parent refresh unchanged", {
      parentSessionId: input.sessionState.sessionId,
    });
    return {
      hasRunningLocalSubagents: !allChildrenTerminal,
      poll: {
        adoptedCallIds,
        childWork,
        rendered: false,
        workRevision: work.revision,
      },
      serializedContext: input.serializedContext,
    };
  }
  ctx.set(WorkGraphKey, work);
  const adapter = ctx.require(ChannelKey);
  const render = adapter.work?.render;
  console.error("[eve.work] parent refresh rendering", {
    parentSessionId: input.sessionState.sessionId,
    renderAvailable: render !== undefined,
    revision: work.revision,
  });
  if (render !== undefined) {
    await render(buildAdapterContext(adapter, ctx), { allowPost: false });
    ctx.set(ChannelKey, { ...adapter, state: { ...ctx.require(ChannelKey).state } });
  }
  const serializedContext = serializeContext(ctx);
  console.error("[eve.work] parent refresh committed", {
    parentSessionId: input.sessionState.sessionId,
    revision: work.revision,
  });
  return {
    hasRunningLocalSubagents: !allChildrenTerminal,
    poll: {
      adoptedCallIds,
      childWork,
      rendered: render !== undefined,
      workRevision: work.revision,
    },
    serializedContext,
  };
}
