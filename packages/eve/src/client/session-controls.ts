import { createClientError } from "#client/client-error.js";
import type { ClientRedirectPolicy } from "#client/types.js";
import { createClientUrl } from "#client/url.js";
import { DeliveryResponseSchema, type DeliveryReceipt } from "#protocol/delivery.js";
import {
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
} from "#protocol/routes.js";

const paths = {
  cancel: createEveSessionCancelRoutePath,
  clear: createEveSessionClearRoutePath,
  compact: createEveSessionCompactRoutePath,
  reset: createEveSessionResetRoutePath,
};

export async function sendClientControl(input: {
  readonly context: {
    readonly host: string;
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
  const { signal, ...body } = input.options ?? {};
  const headers = await input.context.resolveHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(
    createClientUrl(input.context.host, paths[input.kind](input.sessionId)),
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
