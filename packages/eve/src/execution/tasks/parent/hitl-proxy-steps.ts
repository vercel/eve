import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import {
  type DurableSession,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { readWorkflowToolExecutor } from "#execution/tool-run/background.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createTaskInputRequestId,
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { type AgentHandle, getAgentHandleStore } from "#harness/handles/store.js";
import { removeTaskAgentAddressFromState } from "#harness/handles/transitions.js";
import { isInputRequest } from "#shared/input.js";
import {
  cacheTerminalTaskView,
  findSessionTaskEntry,
  type SessionTaskIndexEntry,
} from "#tasks/session-index.js";
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
  if (entry === undefined) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
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
    new Set(eventRequestIds).size !== eventRequestIds.length ||
    eventRequestIds.length !== viewRequestIds.length ||
    eventRequestIds.some((requestId, index) => requestId !== viewRequestIds[index])
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  // The child-advertised token is an answer route, not an identity anchor: a
  // tool run is identified by its run id, a subagent child by its addressed handle.
  const toolRun = readWorkflowToolExecutor(view.executor?.binding);
  if (toolRun !== undefined && toolRun.runId !== input.hookPayload.childSessionId) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const handle =
    toolRun === undefined ? findAddressedTaskHandle(durableSession.state, entry) : undefined;
  if (toolRun === undefined) {
    const entryMetadata = readSubagentTaskMetadata(entry);
    const viewMetadata = readSubagentTaskMetadata(view);
    if (
      handle === undefined ||
      handle.address.sessionId !== input.hookPayload.childSessionId ||
      viewMetadata?.mode !== (handle.address.kind === "agent/remote" ? "remote" : "local") ||
      viewMetadata.agentId !== entryMetadata?.agentId ||
      view.executor?.childSessionId !== input.hookPayload.childSessionId
    ) {
      return { accepted: false, sessionState: input.sessionState };
    }
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
  if (handle?.address.kind === "agent/remote") {
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

function findAddressedTaskHandle(
  state: DurableSession["state"],
  entry: SessionTaskIndexEntry,
): Extract<AgentHandle, { phase: "addressed" }> | undefined {
  const agentId = readSubagentTaskMetadata(entry)?.agentId;
  if (agentId === undefined) return undefined;
  return (getAgentHandleStore(state)?.handles ?? []).find(
    (candidate): candidate is Extract<AgentHandle, { phase: "addressed" }> =>
      candidate.phase === "addressed" && candidate.identity.id === agentId,
  );
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
