import { ClientError } from "#client/client-error.js";
import type {
  CancelSessionResult,
  ClearResult,
  ClientRedirectPolicy,
  CompactResult,
  ResetResult,
} from "#client/types.js";
import { createClientUrl } from "#client/url.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ClearResponseSchema } from "#protocol/clear-session.js";
import { CompactResponseSchema } from "#protocol/compact-session.js";
import { ResetResponseSchema } from "#protocol/reset-session.js";
import {
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
} from "#protocol/routes.js";

interface SessionControlContext {
  readonly host: string;
  readonly redirect?: ClientRedirectPolicy;
  resolveHeaders(): Promise<Headers>;
}

export async function cancelClientSession(input: {
  readonly context: SessionControlContext;
  readonly options?: { readonly turnId?: string };
  readonly sessionId: string;
}): Promise<CancelSessionResult> {
  const { payload, response } = await postJson({
    body: input.options,
    context: input.context,
    operation: "Cancel",
    path: createEveSessionCancelRoutePath(input.sessionId),
  });
  const result = CancelTurnResponseSchema.safeParse(payload);
  if (!result.success || result.data.sessionId !== input.sessionId) {
    throw new Error(`Cancel route returned an invalid response (${response.status}).`);
  }
  return { sessionId: result.data.sessionId, status: result.data.status };
}

export async function clearClientSession(input: {
  readonly context: SessionControlContext;
  readonly sessionId: string;
}): Promise<ClearResult> {
  const { payload } = await postJson({
    context: input.context,
    operation: "Clear",
    path: createEveSessionClearRoutePath(input.sessionId),
  });
  const result = ClearResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" && result.data.sessionId !== input.sessionId)
  ) {
    throw new Error("Clear route returned an invalid response.");
  }
  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_session" };
}

export async function compactClientSession(input: {
  readonly context: SessionControlContext;
  readonly sessionId: string;
}): Promise<CompactResult> {
  const { payload } = await postJson({
    context: input.context,
    operation: "Compact",
    path: createEveSessionCompactRoutePath(input.sessionId),
  });
  const result = CompactResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" && result.data.sessionId !== input.sessionId)
  ) {
    throw new Error("Compact route returned an invalid response.");
  }
  return result.data.status === "accepted"
    ? { sessionId: result.data.sessionId, status: "accepted" }
    : { status: "no_active_session" };
}

export async function resetClientSession(input: {
  readonly context: SessionControlContext;
  readonly options?: { readonly reason?: string };
  readonly sessionId: string;
}): Promise<ResetResult> {
  const { payload } = await postJson({
    body: input.options,
    context: input.context,
    operation: "Reset",
    path: createEveSessionResetRoutePath(input.sessionId),
  });
  const result = ResetResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "reset" && result.data.previousSessionId !== input.sessionId)
  ) {
    throw new Error("Reset route returned an invalid response.");
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

function withRedirectPolicy(init: RequestInit, redirect?: ClientRedirectPolicy): RequestInit {
  return redirect === undefined ? init : { ...init, redirect };
}
