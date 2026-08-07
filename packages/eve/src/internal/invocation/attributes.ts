export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";
export const INVOCATION_UPDATE_RECEIPT_ATTRIBUTE = "$eve.invocation_update";
export const INVOCATION_UPDATE_REQUEST_ID_PREFIX = "mcp-update:";

export interface InvocationUpdateIdentity {
  readonly claim: string;
  readonly requestSet: string;
  readonly receipt: string;
}

export function invocationUpdateIdentityFromRequestId(
  requestId: string | undefined,
): InvocationUpdateIdentity | undefined {
  if (requestId?.startsWith(INVOCATION_UPDATE_REQUEST_ID_PREFIX) !== true) return undefined;
  const value = requestId.slice(INVOCATION_UPDATE_REQUEST_ID_PREFIX.length);
  const [claim, requestSet, receipt, extra] = value.split(":");
  if (!claim || !requestSet || !receipt || extra !== undefined) return undefined;
  return { claim, receipt, requestSet };
}

export function serializeInvocationUpdateIdentity(identity: InvocationUpdateIdentity): string {
  return `${identity.claim}:${identity.requestSet}:${identity.receipt}`;
}

export function parseInvocationUpdateIdentity(
  value: string | undefined,
): InvocationUpdateIdentity | undefined {
  if (value === undefined) return undefined;
  const [claim, requestSet, receipt, extra] = value.split(":");
  if (!claim || !requestSet || !receipt || extra !== undefined) return undefined;
  return { claim, receipt, requestSet };
}
