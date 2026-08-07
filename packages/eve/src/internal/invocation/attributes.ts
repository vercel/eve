import type { TurnStartedStreamEvent } from "#protocol/message.js";

export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";
export const INVOCATION_UPDATE_REQUEST_ID_PREFIX = "mcp-update:";
const INVOCATION_UPDATE_EVENT_KEY = "$eve.invocation_update";

export interface InvocationUpdateIdentity {
  readonly claim: string;
  readonly receipt: string;
}

export function invocationUpdateIdentityFromRequestId(
  requestId: string | undefined,
): InvocationUpdateIdentity | undefined {
  if (requestId?.startsWith(INVOCATION_UPDATE_REQUEST_ID_PREFIX) !== true) return undefined;
  const value = requestId.slice(INVOCATION_UPDATE_REQUEST_ID_PREFIX.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { claim: value.slice(0, separator), receipt: value.slice(separator + 1) };
}

/** Stamps a private durable receipt onto the emitted turn boundary. */
export function stampInvocationUpdateIdentity(
  event: TurnStartedStreamEvent,
  identity: InvocationUpdateIdentity,
): void {
  Object.assign(event.data, { [INVOCATION_UPDATE_EVENT_KEY]: identity });
}

/** Reads a private durable receipt from a persisted turn boundary. */
export function invocationUpdateIdentityFromTurnStartedEvent(
  event: TurnStartedStreamEvent,
): InvocationUpdateIdentity | undefined {
  const value = (event.data as Record<string, unknown>)[INVOCATION_UPDATE_EVENT_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const { claim, receipt } = value as Record<string, unknown>;
  if (typeof claim !== "string" || typeof receipt !== "string") return undefined;
  return { claim, receipt };
}
