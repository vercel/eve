import { ClientError } from "#client/client-error.js";
import type {
  CancelSessionResult,
  ClearResult,
  ClientRedirectPolicy,
  CompactResult,
  ResetResult,
  SessionState,
} from "#client/types.js";
import { createClientUrl } from "#client/url.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ClearResponseSchema } from "#protocol/clear-session.js";
import { CompactResponseSchema } from "#protocol/compact-session.js";
import { ResetResponseSchema } from "#protocol/reset-session.js";
import {
  EVE_CLEAR_SESSION_ROUTE_PATH,
  EVE_COMPACT_SESSION_ROUTE_PATH,
  EVE_RESET_SESSION_ROUTE_PATH,
  createEveCancelTurnRoutePath,
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
} from "#protocol/routes.js";

export type ClientSessionTransport = "legacy" | "sessions";

interface SessionControlContext {
  readonly host: string;
  readonly redirect?: ClientRedirectPolicy;
  resolveHeaders(): Promise<Headers>;
}

export async function cancelClientSession(input: {
  readonly context: SessionControlContext;
  readonly options?: { readonly turnId?: string };
  readonly sessionId: string;
  readonly transport: ClientSessionTransport;
}): Promise<CancelSessionResult> {
  const path =
    input.transport === "sessions"
      ? createEveSessionCancelRoutePath(input.sessionId)
      : createEveCancelTurnRoutePath(input.sessionId);
  const { payload, response } = await postJson({
    body: input.options,
    context: input.context,
    operation: "Cancel",
    path,
  });
  const result = CancelTurnResponseSchema.safeParse(payload);
  if (!result.success || result.data.sessionId !== input.sessionId) {
    throw new Error(`Cancel route returned an invalid response (${response.status}).`);
  }
  return { sessionId: result.data.sessionId, status: result.data.status };
}

export async function clearClientSession(input: {
  readonly context: SessionControlContext;
  readonly state: SessionState;
  readonly transport: ClientSessionTransport;
}): Promise<ClearResult> {
  if (input.transport === "sessions") {
    const sessionId = requireClientSessionId(input.state);
    const { payload } = await postJson({
      context: input.context,
      operation: "Clear",
      path: createEveSessionClearRoutePath(sessionId),
    });
    const result = ClearResponseSchema.safeParse(payload);
    if (
      !result.success ||
      (result.data.status === "accepted" && result.data.sessionId !== sessionId)
    ) {
      throw new Error("Clear route returned an invalid response.");
    }
    return result.data.status === "accepted"
      ? { sessionId: result.data.sessionId, status: "accepted" }
      : { status: "no_active_session" };
  }

  const continuationToken = requireContinuationToken(input.state, "clearing");
  if (continuationToken === undefined) return { status: "no_active_session" };
  const { payload, response } = await postJson({
    body: { continuationToken },
    context: input.context,
    operation: "Clear",
    path: EVE_CLEAR_SESSION_ROUTE_PATH,
  });
  const result = ClearResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" &&
      input.state.sessionId !== undefined &&
      result.data.sessionId !== input.state.sessionId)
  ) {
    throw new Error(`Clear route returned an invalid response (${response.status}).`);
  }
  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_session" };
}

export async function compactClientSession(input: {
  readonly context: SessionControlContext;
  readonly state: SessionState;
  readonly transport: ClientSessionTransport;
}): Promise<CompactResult> {
  if (input.transport === "sessions") {
    const sessionId = requireClientSessionId(input.state);
    const { payload } = await postJson({
      context: input.context,
      operation: "Compact",
      path: createEveSessionCompactRoutePath(sessionId),
    });
    const result = CompactResponseSchema.safeParse(payload);
    if (
      !result.success ||
      (result.data.status === "accepted" && result.data.sessionId !== sessionId)
    ) {
      throw new Error("Compact route returned an invalid response.");
    }
    return result.data.status === "accepted"
      ? { sessionId: result.data.sessionId, status: "accepted" }
      : { status: "no_active_session" };
  }

  const continuationToken = requireContinuationToken(input.state, "compacting");
  if (continuationToken === undefined) return { status: "no_active_session" };
  const { payload, response } = await postJson({
    body: { continuationToken },
    context: input.context,
    operation: "Compact",
    path: EVE_COMPACT_SESSION_ROUTE_PATH,
  });
  const result = CompactResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" &&
      input.state.sessionId !== undefined &&
      result.data.sessionId !== input.state.sessionId)
  ) {
    throw new Error(`Compact route returned an invalid response (${response.status}).`);
  }
  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_session" };
}

export async function resetClientSession(input: {
  readonly context: SessionControlContext;
  readonly options?: { readonly reason?: string };
  readonly state: SessionState;
  readonly transport: ClientSessionTransport;
}): Promise<ResetResult> {
  if (input.transport === "sessions") {
    const sessionId = requireClientSessionId(input.state);
    const { payload } = await postJson({
      body: input.options,
      context: input.context,
      operation: "Reset",
      path: createEveSessionResetRoutePath(sessionId),
    });
    const result = ResetResponseSchema.safeParse(payload);
    if (
      !result.success ||
      (result.data.status === "reset" && result.data.previousSessionId !== sessionId)
    ) {
      throw new Error("Reset route returned an invalid response.");
    }
    return result.data.status === "reset"
      ? { previousSessionId: result.data.previousSessionId, status: "reset" }
      : { status: "no_active_session" };
  }

  const continuationToken = requireContinuationToken(input.state, "resetting");
  if (continuationToken === undefined) return { status: "no_active_session" };
  const { payload, response } = await postJson({
    body: { continuationToken },
    context: input.context,
    operation: "Reset",
    path: EVE_RESET_SESSION_ROUTE_PATH,
  });
  const result = ResetResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "reset" &&
      input.state.sessionId !== undefined &&
      result.data.previousSessionId !== input.state.sessionId)
  ) {
    throw new Error(`Reset route returned an invalid response (${response.status}).`);
  }
  return result.data.status === "reset"
    ? { previousSessionId: result.data.previousSessionId, status: "reset" }
    : { status: "no_active_session" };
}

async function postJson(input: {
  readonly body?: object;
  readonly context: SessionControlContext;
  readonly operation: string;
  readonly path: string;
}): Promise<{ readonly payload: unknown; readonly response: Response }> {
  const headers = await input.context.resolveHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(
    createClientUrl(input.context.host, input.path),
    withRedirectPolicy(
      {
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        headers,
        method: "POST",
      },
      input.context.redirect,
    ),
  );
  const text = await response.text();
  if (!response.ok) throw new ClientError(response.status, text, response.headers);
  try {
    return { payload: JSON.parse(text) as unknown, response };
  } catch {
    throw new Error(`${input.operation} route returned invalid JSON (${response.status}).`);
  }
}

function requireClientSessionId(state: SessionState): string {
  if (state.sessionId === undefined) {
    throw new Error("Session has no session ID. Create or attach a session first.");
  }
  return state.sessionId;
}

function requireContinuationToken(
  state: SessionState,
  operation: "clearing" | "compacting" | "resetting",
): string | undefined {
  if (state.continuationToken !== undefined) return state.continuationToken;
  if (state.sessionId !== undefined) {
    throw new Error(
      `Session has no continuation token. Consume its event stream before ${operation}.`,
    );
  }
  return undefined;
}

function withRedirectPolicy(init: RequestInit, redirect?: ClientRedirectPolicy): RequestInit {
  return redirect === undefined ? init : { ...init, redirect };
}
