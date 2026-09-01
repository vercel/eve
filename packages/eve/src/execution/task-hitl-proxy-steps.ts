import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  type AgentInvocationEvent,
  isAgentInvocationEventEffect,
} from "#execution/tools/subagent/invocation.js";
import {
  createTaskInputRequestId,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { isInputRequest } from "#shared/input.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { cacheTerminalTaskView, findSessionTaskEntry } from "#tasks/session-index.js";
import {
  isTerminalTaskStatus,
  type TaskEffectDelivery,
  type TaskInputRequestDelivery,
  type TaskView,
} from "#tasks/types.js";

/** Validates and records a generic task-owned workflow request. */
export async function recordTaskInputRequestStep(input: {
  readonly request: TaskInputRequestDelivery;
  readonly sessionState: DurableSessionState;
}): Promise<
  | { readonly accepted: false; readonly sessionState: DurableSessionState }
  | {
      readonly accepted: true;
      readonly request: TaskInputRequestDelivery;
      readonly sessionState: DurableSessionState;
    }
> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.request.taskId);
  if (entry === undefined || !isInputRequest(input.request.request)) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  const requestId = input.request.request.requestId;
  if (
    view?.status !== "input_required" ||
    view.inputRequests.length !== 1 ||
    view.inputRequests[0] === null ||
    typeof view.inputRequests[0] !== "object" ||
    Array.isArray(view.inputRequests[0]) ||
    Reflect.get(view.inputRequests[0], "requestId") !== requestId
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  const parentRequestId = createTaskInputRequestId(input.request.taskId, requestId);
  const handle = getAgentHandleStore(durableSession.state)?.handles.find(
    (candidate) => candidate.phase === "claimed" && candidate.taskId === input.request.taskId,
  );
  const remoteResponseUrl =
    handle?.phase === "claimed" && handle.address.kind === "agent/remote"
      ? createRemoteTaskInputCallbackUrl(
          handle.address.url,
          createEveTaskInputRoutePath(createTaskInputCapabilityToken(input.request.replyTo)),
        )
      : undefined;
  const route: { -readonly [K in keyof ProxyInputRequest]: ProxyInputRequest[K] } = {
    childContinuationToken: input.request.replyTo,
    childRequestId: requestId,
    kind: input.request.request.kind,
    taskId: input.request.taskId,
  };
  if (remoteResponseUrl !== undefined) route.childResponseUrl = remoteResponseUrl;
  const state = upsertProxyInputRequestState({
    entries: [[parentRequestId, route]],
    forChildContinuationToken: input.request.replyTo,
    state: durableSession.state,
  });
  return {
    accepted: true,
    request: {
      ...input.request,
      request: { ...input.request.request, requestId: parentRequestId },
    },
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

/** Validates one task-owned agent event before the parent channel sees it. */
export async function acceptTaskAgentEventStep(input: {
  readonly effect: TaskEffectDelivery;
  readonly sessionState: DurableSessionState;
}): Promise<
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly hookPayload: AgentInvocationEvent;
    }
> {
  "use step";

  const effect = { input: input.effect.input, name: input.effect.name };
  if (
    !isAgentInvocationEventEffect(effect) ||
    effect.input.kind !== "subagent-authorization-event"
  ) {
    return { accepted: false };
  }

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.effect.taskId);
  if (entry === undefined) return { accepted: false };

  const handles = getAgentHandleStore(durableSession.state)?.handles ?? [];
  const claimed = handles.find(
    (candidate) =>
      candidate.phase === "claimed" &&
      candidate.taskId === input.effect.taskId &&
      candidate.identity.name === effect.input.subagentName &&
      candidate.address.sessionId === effect.input.childSessionId,
  );
  // A just-started task child can emit authorization before the parent session
  // has processed the matching confirm command. Accept only an unambiguous
  // reservation; confirmed children still bind by child session id.
  const reserved = handles.filter(
    (candidate) =>
      candidate.phase === "reserved" &&
      candidate.taskId === input.effect.taskId &&
      candidate.identity.name === effect.input.subagentName,
  );
  if (claimed === undefined && reserved.length !== 1) return { accepted: false };

  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  if (view === undefined || isTerminalTaskStatus(view.status)) return { accepted: false };
  return { accepted: true, hookPayload: effect.input };
}

/** Caches terminal task views before their workflow runs expire. */
export async function recordTerminalTaskViewsStep(input: {
  readonly sessionState: DurableSessionState;
  readonly views: readonly TaskView[];
}): Promise<DurableSessionState> {
  "use step";
  const durableSession = await readDurableSession(input.sessionState);
  let state = durableSession.state;
  for (const view of input.views) state = cacheTerminalTaskView(state, view);
  if (state === durableSession.state) return input.sessionState;
  return {
    ...input.sessionState,
    snapshot: {
      session: { ...durableSession, state },
      version: input.sessionState.version,
    },
  };
}
