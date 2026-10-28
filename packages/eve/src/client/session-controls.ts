import { PrewarmResponseSchema, type PrewarmSessionResult } from "#protocol/prewarm-session.js";
import { createClientError } from "#client/client-error.js";
import type { ClientRedirectPolicy } from "#client/types.js";
import { createClientUrl } from "#client/url.js";
import { DeliveryResponseSchema, type DeliveryReceipt } from "#protocol/delivery.js";
import {
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
  createEveSessionRoutePath,
} from "#protocol/routes.js";

const paths = {
  cancel: createEveSessionCancelRoutePath,
  clear: createEveSessionClearRoutePath,
  compact: createEveSessionCompactRoutePath,
  reset: createEveSessionResetRoutePath,
};

export async function prewarmClientSession(input: {
  readonly context: {
    readonly baseUrl: string;
    readonly redirect?: ClientRedirectPolicy;
    resolveHeaders(): Promise<Headers>;
  };
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}): Promise<PrewarmSessionResult> {
  // An empty body is the route's preparation request; any field makes it an input delivery.
  const response = await fetch(
    createClientUrl(input.context.baseUrl, createEveSessionRoutePath(input.sessionId)),
    {
      headers: await input.context.resolveHeaders(),
      method: "POST",
      signal: input.signal,
      redirect: input.context.redirect,
    },
  );
  const text = await response.text();
  if (!response.ok) throw createClientError(response.status, text, response.headers);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Prewarm route returned invalid JSON (${response.status}).`);
  }
  const result = PrewarmResponseSchema.safeParse(payload);
  if (!result.success) throw new Error("Prewarm route returned an invalid response.");
  return { status: result.data.status };
}

export async function sendClientControl(input: {
  readonly context: {
    readonly baseUrl: string;
    readonly redirect?: ClientRedirectPolicy;
    resolveHeaders(): Promise<Headers>;
  };
  readonly kind: keyof typeof paths;
  readonly sessionId: string;
  readonly options?: {
    readonly signal?: AbortSignal;
    readonly turnId?: string | null;
    readonly reason?: string;
  };
}): Promise<DeliveryReceipt> {
  const { signal, turnId, reason } = input.options ?? {};
  // Controls reject unknown fields, and option objects passed by variable skip
  // excess-property checks, so each body carries only its own control fields.
  const body = input.kind === "cancel" ? { turnId } : input.kind === "reset" ? { reason } : {};
  const headers = await input.context.resolveHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(
    createClientUrl(input.context.baseUrl, paths[input.kind](input.sessionId)),
    {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal,
      redirect: input.context.redirect,
    },
  );
  const text = await response.text();
  if (!response.ok) throw createClientError(response.status, text, response.headers);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${input.kind} route returned invalid JSON (${response.status}).`);
  }
  const result = DeliveryResponseSchema.safeParse(payload);
  if (!result.success || result.data.sessionId !== input.sessionId)
    throw new Error(`${input.kind} route returned an invalid delivery receipt.`);
  return { sessionId: result.data.sessionId, deliveryId: result.data.deliveryId };
}
