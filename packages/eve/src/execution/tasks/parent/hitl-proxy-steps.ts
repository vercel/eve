import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { readTaskView } from "#execution/tasks/parent/control-shared.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createTaskInputRequestId,
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { removeTaskAgentAddressFromState } from "#harness/handles/transitions.js";
import { isInputRequest } from "#runtime/input/types.js";
import { cacheTerminalTaskView, findSessionTaskEntry } from "#tasks/session-index.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { isTerminalTaskStatus, readSubagentTaskMetadata, type TaskView } from "#tasks/types.js";

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
}): Promise<
  | { readonly accepted: false }
  | { readonly accepted: true; readonly hookPayload: SubagentAuthorizationEventHookPayload }
> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  if (entry === undefined) return { accepted: false };
  const entryMetadata = readSubagentTaskMetadata(entry);
  if (entryMetadata === undefined) return { accepted: false };
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entryMetadata.agentId,
  );
  const handleMatches =
    handle?.phase === "addressed" && handle.address.sessionId === input.hookPayload.childSessionId;
  const view = await readTaskView(entry);
  const viewMetadata = view === undefined ? undefined : readSubagentTaskMetadata(view);
  const viewMatches =
    view.executor?.childSessionId === input.hookPayload.childSessionId &&
    viewMetadata?.agentId === entryMetadata.agentId;
  const eventType = input.hookPayload.event.type;
  const isApprovalLifecycleEvent =
    eventType === "approval.candidate" || eventType === "approval.settled";
  if (isApprovalLifecycleEvent) {
    if (!viewMatches || (!isTerminalTaskStatus(view.status) && !handleMatches)) {
      return { accepted: false };
    }
    return {
      accepted: true,
      hookPayload: namespaceTaskApprovalEvent(input.hookPayload, input.taskId),
    };
  }
  if (!handleMatches || isTerminalTaskStatus(view.status) || !viewMatches) {
    return { accepted: false };
  }
  return { accepted: true, hookPayload: input.hookPayload };
}

function namespaceTaskApprovalEvent(
  hookPayload: SubagentAuthorizationEventHookPayload,
  taskId: string,
): SubagentAuthorizationEventHookPayload {
  switch (hookPayload.event.type) {
    case "approval.candidate":
      return {
        ...hookPayload,
        event: {
          ...hookPayload.event,
          data: {
            ...hookPayload.event.data,
            requestId: createTaskInputRequestId(taskId, hookPayload.event.data.requestId),
          },
        },
      };
    case "approval.settled":
      return {
        ...hookPayload,
        event: {
          ...hookPayload.event,
          data: {
            ...hookPayload.event.data,
            requestId: createTaskInputRequestId(taskId, hookPayload.event.data.requestId),
          },
        },
      };
    default:
      return hookPayload;
  }
}

/** Caches terminal task views before their workflow runs can expire. */
export async function recordTerminalTaskViewsStep(input: {
  readonly sessionState: DurableSessionState;
  readonly views: readonly TaskView[];
}): Promise<DurableSessionState> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  let state = durableSession.state;
  for (const view of input.views) {
    state = cacheTerminalTaskView(state, view);
    if (view.executor?.lifecycle === "terminal") {
      const metadata = readSubagentTaskMetadata(view);
      if (metadata !== undefined) {
        state = removeTaskAgentAddressFromState(state, metadata.agentId);
      }
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
