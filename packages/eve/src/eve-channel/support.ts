import type { MessageContent } from "#shared/message-content.js";

import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { DeliveryReceipt } from "#protocol/delivery.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
import type { SessionAuthContext } from "#channel/types.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  defaultEveAuth,
  type EveChannelInput,
  type EveHandle,
  type EveMessageContext,
  type EveMessageResult,
} from "#eve-channel/types.js";

const log = createLogger("eve.channel");

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });
}

/** Clients display the error text directly; keep operator details in structured fields. */
export function sessionCommandErrorResponse(error: unknown): Response | undefined {
  if (SessionNotActiveError.is(error)) {
    return Response.json(
      {
        ok: false,
        code: error.retryable ? "session_not_ready" : "session_not_active",
        error: error.retryable
          ? "The session is not ready to accept messages yet."
          : "The session is no longer active.",
      },
      { headers: { "cache-control": "no-store" }, status: 409 },
    );
  }
  if (!SessionStrandedError.is(error)) return undefined;
  const body: Record<string, unknown> = {
    code: "session_stranded",
    error: "This session is no longer available.",
    ok: false,
  };
  if (error.owner.eveVersion !== undefined) body.eveVersion = error.owner.eveVersion;
  return Response.json(body, { headers: { "cache-control": "no-store" }, status: 409 });
}

export function deliveryResponse(receipt: DeliveryReceipt): Response {
  return Response.json(
    { ok: true, sessionId: receipt.sessionId, deliveryId: receipt.deliveryId },
    {
      headers: { "cache-control": "no-store", [EVE_SESSION_ID_HEADER]: receipt.sessionId },
      status: 202,
    },
  );
}

/** Where a remote child the parent session recorded runs, and its credential key. */
export interface RemoteAgentBinding {
  readonly forwardPrincipal?: boolean;
  readonly name: string;
  readonly resolverId?: string;
  readonly url: string;
  /** The child's remote agent protocol, when it speaks an earlier one. */
  readonly earlierProtocol?: number;
}

interface RemoteAgentStreamCoordinates {
  readonly callId: string;
  readonly childSessionId: string;
  readonly childStreamPath: string;
}

/** Finds the remote child the parent session recorded for one proxy route, from its private binding. */
export async function findRemoteAgentBinding(
  input: RemoteAgentStreamCoordinates & {
    readonly parent: {
      getChildBinding?(childSessionId: string): Promise<
        | {
            readonly callId: string;
            readonly name: string;
            readonly resolverId?: string;
            readonly streamPath: string;
            readonly url: string;
            readonly earlierProtocol?: number;
          }
        | undefined
      >;
    };
  },
): Promise<RemoteAgentBinding | undefined> {
  const recorded = await input.parent.getChildBinding?.(input.childSessionId);
  // The stream path embeds the parent session id, so matching it binds the parent.
  if (
    recorded === undefined ||
    recorded.callId !== input.callId ||
    recorded.streamPath !== input.childStreamPath
  )
    return undefined;
  const binding: { -readonly [K in keyof RemoteAgentBinding]: RemoteAgentBinding[K] } = {
    name: recorded.name,
    url: recorded.url,
  };
  if (recorded.resolverId !== undefined) binding.resolverId = recorded.resolverId;
  if (recorded.earlierProtocol !== undefined) binding.earlierProtocol = recorded.earlierProtocol;
  return binding;
}

interface OnMessageOutcome {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
}

export async function resolveOnMessage(input: {
  readonly auth: SessionAuthContext | null;
  readonly config: EveChannelInput;
  readonly invocation?: EveHandle["invocation"];
  readonly message: MessageContent;
  readonly request: Request;
  readonly sessionId?: string;
}): Promise<OnMessageOutcome | Response> {
  const handler = input.config.onMessage ?? defaultOnMessage;

  let result: EveMessageResult;
  try {
    const base = { caller: input.auth, request: input.request };
    const eve: EveHandle =
      input.sessionId === undefined
        ? input.invocation === undefined
          ? base
          : { ...base, invocation: input.invocation }
        : { ...base, sessionId: input.sessionId };
    const ctx: EveMessageContext = { eve };
    result = await handler(ctx, input.message);
    if (result === null || result === undefined) {
      throw new TypeError("eveChannel onMessage must return an auth result.");
    }
  } catch (error) {
    const errorId = logError(log, "onMessage handler failed", error, {
      sessionId: input.sessionId,
    });
    return Response.json(
      { error: "onMessage handler failed.", errorId, ok: false },
      { status: 500 },
    );
  }

  return { auth: result.auth, context: result.context, title: result.title };
}

function defaultOnMessage(ctx: EveMessageContext): EveMessageResult {
  return { auth: defaultEveAuth(ctx) };
}
