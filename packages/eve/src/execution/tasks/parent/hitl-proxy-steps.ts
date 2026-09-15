import { contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createTaskInputRequestId,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { isInputRequest } from "#shared/input.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { applyTaskAgentHandleCommand } from "#subagents/handles/transitions.js";
import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { cacheTerminalTaskView, findSessionTaskEntry } from "#tasks/session-index.js";
import type { TaskInputRequestDelivery, TaskView } from "#tasks/types.js";

const log = createLogger("execution.tasks.parent");

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
    view.inputRequests.length !== requestIds.length ||
    !view.inputRequests.every(
      (request, index) =>
        request !== null &&
        typeof request === "object" &&
        !Array.isArray(request) &&
        Reflect.get(request, "requestId") === requestIds[index],
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
          createEveTaskInputRoutePath(createTaskInputCapabilityToken(input.request.replyTo)),
        )
      : undefined;
  const entries = requests.map((request, index) => {
    const parentRequest = parentRequests[index]!;
    const route: { -readonly [K in keyof ProxyInputRequest]: ProxyInputRequest[K] } = {
      childContinuationToken: input.request.replyTo,
      childRequestId: request.requestId,
      kind: request.kind,
      taskId: input.request.taskId,
    };
    if (remoteResponseUrl !== undefined) route.childResponseUrl = remoteResponseUrl;
    return [parentRequest.requestId, route] as const;
  });
  const state = upsertProxyInputRequestState({
    entries,
    forChildContinuationToken: input.request.replyTo,
    state: durableSession.state,
  });
  const request: TaskInputRequestDelivery =
    input.request.requests === undefined
      ? { ...input.request, request: parentRequests[0]! }
      : { ...input.request, request: undefined, requests: parentRequests };
  return {
    accepted: true,
    request,
    sessionState: replaceDurableSessionSnapshot({
      session: { ...durableSession, state },
      state: input.sessionState,
    }),
  };
}

/** Caches terminal task views before their workflow runs expire. */
export async function recordTerminalTaskViewsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly views: readonly TaskView[];
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";
  const durableSession = readDurableSession(input.sessionState);
  let session = durableSession;
  const acceptedViews: TaskView[] = [];
  for (const view of input.views) {
    if (findSessionTaskEntry(session.state, view.taskId) === undefined) continue;
    const state = cacheTerminalTaskView(session.state, view);
    if (state !== session.state) session = { ...session, state };
    acceptedViews.push(view);
    session = applyTaskAgentHandleCommand(session, {
      kind: "release-owner",
      ownerId: view.taskId,
    }).session;
  }
  const serializedContext = await settleBackgroundTaskActions({
    serializedContext: input.serializedContext,
    session,
    views: acceptedViews,
  });
  const sessionState =
    session === durableSession
      ? input.sessionState
      : replaceDurableSessionSnapshot({ session, state: input.sessionState });
  return { serializedContext, sessionState };
}

async function settleBackgroundTaskActions(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly session: Awaited<ReturnType<typeof readDurableSession>>;
  readonly views: readonly TaskView[];
}): Promise<Record<string, unknown>> {
  if (input.views.length === 0) return input.serializedContext;
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return input.serializedContext;
    const instrumentation = bindSessionInstrumentation({
      agentName: bundle.turnAgent.id,
      ctx,
      rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
      sessionId: input.session.sessionId,
    });
    if (instrumentation === undefined) return input.serializedContext;
    try {
      await contextStorage.run(ctx, () =>
        instrumentation.publishBackgroundTaskSettlements({
          acceptedAtMs: Date.now(),
          views: input.views,
        }),
      );
    } finally {
      await instrumentation.flush();
    }
    return serializeContext(ctx);
  } catch (error) {
    log.warn("failed to settle background task instrumentation", {
      error,
      sessionId: input.session.sessionId,
      taskIds: input.views.map((view) => view.taskId),
    });
    return input.serializedContext;
  }
}
