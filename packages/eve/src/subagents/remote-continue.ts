import type { ActivityObserverConfig, SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { ForwardedPrincipal } from "#channel/forwarded-principal.js";
import { AgentHandleError } from "#protocol/agent-handle-error.js";
import { createEveSessionReportRoutePath, createEveSessionRoutePath } from "#protocol/routes.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import type { InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import {
  buildForwardedPrincipalField,
  resolveRemoteAgentRequestHeaders,
} from "#subagents/remote-dispatch.js";
import { createRemoteAgentRouteUrl } from "#subagents/remote-route-url.js";
import {
  readJsonBody,
  readTaskProtocol,
  readTaskProtocolRejection,
  RemoteTaskProtocolError,
} from "#subagents/remote-protocol.js";
import { TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";

// Owner → remote child requests on an existing session: new work, steering
// messages, answers to its input requests, and the deadline's one read.

/** How long the deadline's reconciliation read waits for a remote. */
const REPORT_READ_TIMEOUT_MS = 10_000;

/** The owner's callback for the call a request belongs to. */
export interface RemoteCallback {
  readonly callId: string;
  readonly subagentName: string;
  readonly token: string;
  readonly url: string;
}

/**
 * Continues one remote-agent session by its immutable session ID. The
 * request carries the owner's callback for the call it belongs to and an
 * `operationId`, so the remote admits it once even when a retried step
 * sends it again. With `turnPolicy: "steer"` it is a steering message for
 * that call; `"queue"` starts the call's next turn.
 */
export async function continueRemoteAgentSession(input: {
  readonly activityObserver?: ActivityObserverConfig;
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth: SessionAuthContext | null;
  readonly callback: RemoteCallback;
  readonly message: string;
  readonly operationId: string;
  readonly outputSchema?: JsonObject;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
  readonly turnPolicy: TurnPolicy;
}): Promise<void> {
  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    activityObserver?: ActivityObserverConfig;
    callback: RemoteCallback;
    forwardedPrincipal?: ForwardedPrincipal;
    message: string;
    operationId: string;
    outputSchema?: JsonObject;
    taskProtocol: number;
    turnPolicy: TurnPolicy;
  } = {
    activityObserver: input.activityObserver,
    callback: input.callback,
    message: input.message,
    operationId: input.operationId,
    outputSchema: input.outputSchema,
    taskProtocol: TASK_PROTOCOL_VERSION,
    turnPolicy: input.turnPolicy,
  };
  if (forwardedPrincipal !== undefined) requestBody.forwardedPrincipal = forwardedPrincipal;
  await postSessionMessage({
    body: requestBody,
    forwardsPrincipal: forwardedPrincipal !== undefined,
    remote: input.remote,
    sessionId: input.sessionId,
  });
}

/**
 * Answers input requests a remote child surfaced through its owner. The
 * child validates each answer's request ID, so a repeated answer changes
 * nothing.
 */
export async function answerRemoteAgentSession(input: {
  /** The answering principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth: SessionAuthContext | null;
  readonly inputResponses: readonly InputResponse[];
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
}): Promise<void> {
  const forwardedPrincipal = buildForwardedPrincipalField(input);
  await postSessionMessage({
    body: {
      forwardedPrincipal,
      inputResponses: input.inputResponses,
      taskProtocol: TASK_PROTOCOL_VERSION,
    },
    forwardsPrincipal: forwardedPrincipal !== undefined,
    remote: input.remote,
    sessionId: input.sessionId,
  });
}

/**
 * Reads the latest result a remote child reported for one call: the body of
 * the callback it sent. `undefined` when it has not answered the call, or the
 * read fails; the owner then treats the call as unfinished.
 */
export async function readRemoteAgentReport(input: {
  readonly callId: string;
  readonly remote: Pick<ResolvedRuntimeRemoteAgentNode, "auth" | "headers" | "name" | "url">;
  readonly sessionId: string;
}): Promise<unknown> {
  const response = await fetch(
    createRemoteAgentRouteUrl(
      input.remote.url,
      createEveSessionReportRoutePath(input.sessionId, input.callId),
    ),
    {
      headers: await resolveRemoteAgentRequestHeaders(input.remote),
      method: "GET",
      signal: AbortSignal.timeout(REPORT_READ_TIMEOUT_MS),
    },
  );
  const body = await readJsonBody(response);
  if (!response.ok || readTaskProtocol(body) !== TASK_PROTOCOL_VERSION) return undefined;
  const report = body !== null && typeof body === "object" ? Reflect.get(body, "report") : null;
  return report ?? undefined;
}

async function postSessionMessage(input: {
  readonly body: Record<string, unknown>;
  readonly forwardsPrincipal: boolean;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
}): Promise<void> {
  const response = await fetch(
    createRemoteAgentRouteUrl(input.remote.url, createEveSessionRoutePath(input.sessionId)),
    {
      body: JSON.stringify(input.body),
      headers: {
        "content-type": "application/json",
        ...(await resolveRemoteAgentRequestHeaders(input.remote)),
      },
      method: "POST",
    },
  );
  if (response.ok) return;

  const body = await readJsonBody(response);
  const protocolError = readTaskProtocolRejection({
    body,
    name: input.remote.name,
    status: response.status,
  });
  if (protocolError !== undefined) throw protocolError;
  const code = body !== null && typeof body === "object" ? Reflect.get(body, "code") : undefined;
  const permanent = response.status === 404 || code === AgentHandleError.SessionNotResumable.code;
  const compatibilityHint =
    response.status === 400 && input.forwardsPrincipal
      ? " The receiver may support forwarded principals only on session creation; upgrade it before retrying."
      : "";
  throw new RemoteAgentContinueRequestError(
    `Remote agent "${input.remote.name}" continue-session request failed${
      permanent ? " permanently" : ""
    } with HTTP ${response.status}.${compatibilityHint}`,
    {
      deliveryAmbiguous: isAmbiguousRemoteContinueStatus(response.status),
      retryable: !permanent,
    },
  );
}

/**
 * Failure of a continue-session request, classified at the HTTP boundary.
 * Exported so tests can exercise {@link isRetryableRemoteAgentContinueError}
 * with real instances instead of re-encoding the classification.
 */
export class RemoteAgentContinueRequestError extends Error {
  readonly deliveryAmbiguous: boolean;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly deliveryAmbiguous: boolean; readonly retryable: boolean },
  ) {
    super(message);
    this.name = "RemoteAgentContinueRequestError";
    this.deliveryAmbiguous = options.deliveryAmbiguous;
    this.retryable = options.retryable;
  }
}

/**
 * Returns true when a failed continue request may be retried. A session that
 * no longer exists (404 / SESSION_NOT_RESUMABLE) and a remote on another task
 * protocol version are permanent; transient HTTP and network failures stay
 * retryable so the owner keeps the agent and the model decides whether to
 * try the same agentId again.
 */
export function isRetryableRemoteAgentContinueError(error: unknown): boolean {
  if (error instanceof RemoteTaskProtocolError) return false;
  return !(error instanceof RemoteAgentContinueRequestError) || error.retryable;
}

/** Whether the callee may have accepted the continuation before delivery failed. */
export function isAmbiguousRemoteAgentContinueError(error: unknown): boolean {
  if (error instanceof RemoteTaskProtocolError) return false;
  return !(error instanceof RemoteAgentContinueRequestError) || error.deliveryAmbiguous;
}

function isAmbiguousRemoteContinueStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}
