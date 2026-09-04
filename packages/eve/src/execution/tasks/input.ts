import { replyTargetToken } from "#execution/inbox/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/session/state.js";
import { readLatestTaskView } from "#execution/tasks/runtime.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createTaskInputRequestId,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { isInputRequest } from "#shared/input.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { applyTaskAgentHandleCommand } from "#subagents/handles/transitions.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { cacheTerminalTaskView, findSessionTaskEntry } from "#tasks/session-index.js";
import type { TaskInputRequestDelivery, TaskView } from "#tasks/types.js";

/** Validates and records a generic task-owned workflow request. */
export async function recordTaskInputRequest(input: {
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
  const durableSession = readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.request.taskId);
  const requests = input.request.requests ?? [input.request.request];
  if (entry === undefined || requests.length === 0 || !requests.every(isInputRequest)) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
  const requestIds = requests.map((request) => request.requestId);
  if (
    view?.status !== "input_required" ||
    !requestIds.every((requestId) =>
      view.inputRequests.some(
        (request) =>
          request !== null &&
          typeof request === "object" &&
          !Array.isArray(request) &&
          Reflect.get(request, "requestId") === requestId,
      ),
    )
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  const parentRequests = requests.map((request) => ({
    ...request,
    requestId: createTaskInputRequestId(input.request.taskId, request.requestId),
  }));
  const handle = getAgentHandleStore(durableSession.state)?.handles.find(
    (candidate) => candidate.phase === "claimed" && candidate.ownerId === input.request.taskId,
  );
  const remoteResponseUrl =
    handle?.phase === "claimed" && handle.address.kind === "agent/remote"
      ? createRemoteTaskInputCallbackUrl(
          handle.address.url,
          createEveTaskInputRoutePath(
            createTaskInputCapabilityToken(replyTargetToken(input.request.replyTo)),
          ),
        )
      : undefined;
  const entries = requests.map((request, index) => {
    const parentRequest = parentRequests[index]!;
    const route: { -readonly [K in keyof ProxyInputRequest]: ProxyInputRequest[K] } = {
      childContinuationToken: replyTargetToken(input.request.replyTo),
      childRequestId: request.requestId,
      kind: request.kind,
      taskId: input.request.taskId,
    };
    if (remoteResponseUrl !== undefined) route.childResponseUrl = remoteResponseUrl;
    if (input.request.replyTo.kind === "inbox") route.inboxResponse = input.request.replyTo;
    return [parentRequest.requestId, route] as const;
  });
  const state = upsertProxyInputRequestState({
    entries,
    forChildContinuationToken: replyTargetToken(input.request.replyTo),
    state: durableSession.state,
  });
  const request: TaskInputRequestDelivery =
    input.request.requests === undefined
      ? { ...input.request, request: parentRequests[0]! }
      : { ...input.request, request: undefined, requests: parentRequests };
  return {
    accepted: true,
    request,
    sessionState: {
      ...input.sessionState,
      hasProxyInputRequests: true,
      snapshot: {
        session: { ...durableSession, state },
      },
    },
  };
}

/** Caches terminal task views before their workflow runs expire. */
export async function recordTerminalTaskViews(input: {
  readonly sessionState: DurableSessionState;
  readonly views: readonly TaskView[];
}): Promise<DurableSessionState> {
  const durableSession = readDurableSession(input.sessionState);
  let session = durableSession;
  for (const view of input.views) {
    if (findSessionTaskEntry(session.state, view.taskId) === undefined) continue;
    const state = cacheTerminalTaskView(session.state, view);
    if (state !== session.state) session = { ...session, state };
    session = applyTaskAgentHandleCommand(session, {
      kind: "release-owner",
      ownerId: view.taskId,
    }).session;
  }
  if (session === durableSession) return input.sessionState;
  return {
    ...input.sessionState,
    snapshot: {
      session,
    },
  };
}
