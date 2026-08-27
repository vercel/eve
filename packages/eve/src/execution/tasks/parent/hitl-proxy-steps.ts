import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createTaskInputRequestId,
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { isInputRequest } from "#shared/input.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { isTerminalTaskStatus, readSubagentTaskMetadata } from "#tasks/types.js";

/** Validates and durably records one task-owned child HITL route batch. */
export async function recordTaskInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<
  | { readonly accepted: false; readonly sessionState: DurableSessionState }
  | {
      readonly accepted: true;
      readonly hookPayload: SubagentInputRequestHookPayload;
      readonly sessionState: DurableSessionState;
    }
> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  const entryMetadata = entry === undefined ? undefined : readSubagentTaskMetadata(entry);
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entryMetadata?.agentId,
  );
  if (
    entry === undefined ||
    handle?.phase !== "addressed" ||
    handle.address.sessionId !== input.hookPayload.childSessionId
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }
  // Remote creates are ID-addressed and return no continuation token, so
  // provenance rests on the sessionId match above plus the strict view
  // checks below; the child-advertised token is only used as the answer
  // route, never as an identity anchor.
  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  const viewMetadata = view === undefined ? undefined : readSubagentTaskMetadata(view);
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
    viewMetadata?.mode !== (handle.address.kind === "agent/remote" ? "remote" : "local") ||
    viewMetadata.agentId !== entryMetadata?.agentId ||
    view.executor?.childSessionId !== input.hookPayload.childSessionId ||
    new Set(eventRequestIds).size !== eventRequestIds.length ||
    eventRequestIds.length !== viewRequestIds.length ||
    eventRequestIds.some((requestId, index) => requestId !== viewRequestIds[index])
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  const hookPayload = namespaceTaskInputRequests(input.hookPayload, input.taskId);
  let entries = toProxyInputRequestEntries(hookPayload, input.taskId).map(
    ([requestId, route], index) => {
      const childRequestId = input.hookPayload.event.requests[index]!.requestId;
      return [
        requestId,
        {
          ...route,
          childRequestId,
        },
      ] as const;
    },
  );
  if (handle.address.kind === "agent/remote") {
    const childResponseUrl = createRemoteTaskInputCallbackUrl(
      handle.address.url,
      createEveTaskInputRoutePath(
        createTaskInputCapabilityToken(input.hookPayload.childContinuationToken),
      ),
    );
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
    hookPayload,
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

function namespaceTaskInputRequests(
  hookPayload: SubagentInputRequestHookPayload,
  taskId: string,
): SubagentInputRequestHookPayload {
  return {
    ...hookPayload,
    event: {
      ...hookPayload.event,
      requests: hookPayload.event.requests.map((request) => ({
        ...request,
        requestId: createTaskInputRequestId(taskId, request.requestId),
      })),
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
  const entryMetadata = readSubagentTaskMetadata(entry);
  if (entryMetadata === undefined) return false;
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entryMetadata.agentId,
  );
  if (
    handle?.phase !== "addressed" ||
    handle.address.sessionId !== input.hookPayload.childSessionId
  ) {
    return false;
  }
  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  const viewMetadata = view === undefined ? undefined : readSubagentTaskMetadata(view);
  return (
    view !== undefined &&
    !isTerminalTaskStatus(view.status) &&
    view.executor?.childSessionId === input.hookPayload.childSessionId &&
    viewMetadata?.agentId === entryMetadata.agentId
  );
}
