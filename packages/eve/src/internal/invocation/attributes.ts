export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";
export const INVOCATION_UPDATE_RECEIPT_ATTRIBUTE = "$eve.invocation_update";
export const INVOCATION_UPDATE_REQUEST_ID_PREFIX = "mcp-update:";

export function invocationUpdateReceiptFromRequestId(
  requestId: string | undefined,
): string | undefined {
  return requestId?.startsWith(INVOCATION_UPDATE_REQUEST_ID_PREFIX) === true
    ? requestId.slice(INVOCATION_UPDATE_REQUEST_ID_PREFIX.length)
    : undefined;
}
