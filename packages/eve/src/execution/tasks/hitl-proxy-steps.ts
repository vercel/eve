import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import {
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { removeTaskAgentAddressFromState } from "#harness/handles/transitions.js";
import { isInputRequest } from "#runtime/input/types.js";
import { cacheTerminalTaskSnapshot, findSessionTaskEntry } from "#tasks/session-index.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import type { TaskView } from "#tasks/types.js";

/** Validates and durably records one task-owned child HITL route batch. */
export async function recordTaskInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<{ readonly accepted: boolean; readonly sessionState: DurableSessionState }> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entry?.metadata.agentId,
  );
  if (
    entry === undefined ||
    handle?.phase !== "addressed" ||
    handle.address.sessionId !== input.hookPayload.childSessionId
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  const eventRequestIds = input.hookPayload.event.requests.map((request) => request.requestId);
  const viewRequestIds =
    view?.inputRequests?.map((request) =>
      request !== null && typeof request === "object" && !Array.isArray(request)
        ? Reflect.get(request, "requestId")
        : undefined,
    ) ?? [];
  if (
    view?.status !== "input_required" ||
    !input.hookPayload.event.requests.every(isInputRequest) ||
    view.metadata.mode !== (handle.address.kind === "agent/remote" ? "remote" : "local") ||
    view.metadata.agentId !== entry.metadata.agentId ||
    view.executor?.childSessionId !== input.hookPayload.childSessionId ||
    new Set(eventRequestIds).size !== eventRequestIds.length ||
    eventRequestIds.length !== viewRequestIds.length ||
    eventRequestIds.some((requestId, index) => requestId !== viewRequestIds[index])
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  let entries = toProxyInputRequestEntries(input.hookPayload, input.taskId);
  if (handle.address.kind === "agent/remote") {
    const childResponseUrl = new URL(
      createEveTaskInputRoutePath(input.hookPayload.childContinuationToken),
      handle.address.url,
    ).href;
    entries = entries.map(
      ([requestId, route]) => [requestId, { ...route, childResponseUrl }] as const,
    );
  }
  const state = upsertProxyInputRequestState({
    entries,
    forChildContinuationToken: input.hookPayload.childContinuationToken,
    state: durableSession.state,
  });
  return {
    accepted: true,
    sessionState: {
      ...input.sessionState,
      hasProxyInputRequests: true,
      snapshot: {
        session: { ...durableSession, state },
        version: input.sessionState.version,
      },
    },
  };
}

/** Validates that one task authorization event came from its owned child address. */
export async function acceptTaskAuthorizationEventStep(input: {
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<boolean> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  if (entry === undefined) return false;
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entry.metadata.agentId,
  );
  if (
    handle?.phase !== "addressed" ||
    handle.address.sessionId !== input.hookPayload.childSessionId
  ) {
    return false;
  }
  const view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  return (
    view?.executor?.childSessionId === input.hookPayload.childSessionId &&
    view.metadata.agentId === entry.metadata.agentId
  );
}

/** Caches terminal task snapshots before their workflow runs can expire. */
export async function recordTerminalTaskSnapshotsStep(input: {
  readonly sessionState: DurableSessionState;
  readonly snapshots: readonly TaskView[];
}): Promise<DurableSessionState> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  let state = durableSession.state;
  for (const snapshot of input.snapshots) {
    state = cacheTerminalTaskSnapshot(state, snapshot);
    if (snapshot.executor?.lifecycle === "terminal") {
      state = removeTaskAgentAddressFromState(state, snapshot.metadata.agentId);
    }
  }
  if (state === durableSession.state) return input.sessionState;
  return {
    ...input.sessionState,
    snapshot: {
      session: { ...durableSession, state },
      version: input.sessionState.version,
    },
  };
}
