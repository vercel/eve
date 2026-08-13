export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";

export interface InvocationAttributesInput {
  readonly continuationToken: string;
  readonly ownerKey: string;
}

export function buildInvocationAttributes(
  input: InvocationAttributesInput,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: input.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: input.continuationToken,
  };
}
