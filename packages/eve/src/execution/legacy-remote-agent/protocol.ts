/**
 * Remote agent protocol 1: what an eve 0.66–0.68 caller sends a remote agent
 * and expects back. A remote agent keeps serving those callers so it can
 * deploy before them.
 *
 * Everything protocol 1 needs lives here. Guard rule 48 limits imports of this
 * directory to the ingress files that route into it, so removing protocol 1
 * means deleting this directory and fixing the compile errors it leaves.
 */
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { isObject } from "#shared/guards.js";
import { isInputResponse } from "#shared/input.js";

const log = createLogger("execution.legacy-remote-agent");

export const LEGACY_REMOTE_AGENT_PROTOCOL_VERSION = 1;

const TASK_INPUT_TOKEN_RE = /^eve:task-input:([a-f0-9]{32})$/;

/** A session created by a protocol-1 caller. */
export interface LegacyRemoteAgentCaller {
  /**
   * The caller's background task; its questions and sign-ins are forwarded
   * only with one. Captured at create: a 0.66–0.68 caller's model-called
   * agents start in a task, and those callers never check it against later turns.
   */
  readonly taskId?: string;
}

/**
 * Removes the `callback.taskId` a protocol-1 caller adds when it delegates
 * from a background task. Current callers don't send it. The task id is
 * returned so the session can name it back to the caller. The caller's
 * `activityObserver` needs no removal: eve ignores that field from any caller.
 */
export function splitLegacyTaskFields(input: Record<string, unknown>): {
  readonly payload: Record<string, unknown>;
  readonly taskId?: string;
} {
  const { callback } = input;
  if (!isObject(callback) || !("taskId" in callback)) return { payload: input };
  const { taskId, ...rest } = callback;
  const payload = { ...input, callback: rest };
  return typeof taskId === "string" && taskId.length > 0 ? { payload, taskId } : { payload };
}

/**
 * Sends a question, approval, or sign-in to a protocol-1 caller in the
 * `task.*` callback it expects. Returns whether the event was forwarded and
 * must stay off this session's own channel.
 */
export async function forwardLegacySessionInput(
  ctx: ContextContainer,
  caller: LegacyRemoteAgentCaller,
  event: UnstampedMessageStreamEvent,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  // The caller answers through the create-once session token it derived its capability from.
  const childContinuationToken = ctx.get(ContinuationTokenKey);
  if (caller.taskId === undefined || callback === undefined || !childContinuationToken) {
    return false;
  }
  let forwarded: { readonly event: unknown; readonly kind: string };
  if (event.type === "input.requested") {
    forwarded = { event: event.data, kind: "task.input-requested" };
  } else if (event.type === "authorization.required" || event.type === "authorization.completed") {
    forwarded = { event, kind: "task.authorization" };
  } else {
    return false;
  }

  const response = await postSessionCallbackRequest({
    body: {
      callId: callback.callId,
      childContinuationToken,
      childSessionId: ctx.require(SessionIdKey),
      event: forwarded.event,
      kind: forwarded.kind,
      subagentName: callback.subagentName,
      taskId: caller.taskId,
    },
    url: callback.url,
  });
  if (!response.ok) {
    throw new Error(`Remote task event callback failed with HTTP ${response.status}.`);
  }
  return true;
}

/** Route a protocol-1 caller posts its answers to a remote agent's question or approval. */
export const legacyTaskInputRoute = {
  handler: handleLegacyTaskInputRequest,
  path: `${EVE_ROUTE_PREFIX}/task-input/:token`,
} as const;

/**
 * Delivers a protocol-1 caller's answers. The token is the capability the
 * caller derived from this session's create-once continuation token, so it
 * authorizes the request on its own, as it did in protocol 1.
 */
async function handleLegacyTaskInputRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const digest = TASK_INPUT_TOKEN_RE.exec(ctx.params.token ?? "")?.[1];
  if (digest === undefined) {
    return Response.json({ error: "Invalid task input token.", ok: false }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  const inputResponses = isObject(body) ? body.inputResponses : undefined;
  if (
    !Array.isArray(inputResponses) ||
    inputResponses.length === 0 ||
    !inputResponses.every(isInputResponse)
  ) {
    return Response.json(
      { error: "Expected a non-empty inputResponses array.", ok: false },
      { status: 400 },
    );
  }

  try {
    // No auth: the answer acts as the session's current principal, as in protocol 1.
    await resumeSessionInbox(`eve:eve:op:${digest}`, {
      kind: "send",
      payload: { inputResponses },
    });
  } catch (error) {
    if (HookNotFoundError.is(error)) {
      return Response.json(
        { error: "Task input target is not pending.", ok: false },
        { status: 404 },
      );
    }
    const errorId = logError(log, "legacy task input delivery failed", error);
    return Response.json(
      { error: "Failed to deliver the task input.", errorId, ok: false },
      { status: 500 },
    );
  }
  return Response.json({ ok: true }, { status: 202 });
}
