import type { SessionAuthContext } from "#channel/types.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { JsonValue } from "#shared/json.js";

export const CHANNEL_AUTHENTICATION_PAYLOAD_KEY = "eve.channelAuthentication";

export interface ChannelAuthenticationPayload {
  readonly event: unknown;
}

export type ChannelAuthenticationResolution =
  | { readonly kind: "authenticated"; readonly auth: SessionAuthContext }
  | { readonly kind: "not-authenticated" }
  | {
      readonly kind: "interaction-required";
      readonly challenge: ConnectionAuthorizationChallenge;
      readonly resume?: JsonValue;
      readonly strategyIndex: number;
    };

export interface ChannelAuthenticationCallbackInput {
  readonly callback: AuthorizationCallback;
  readonly callbackUrl: string;
  readonly event: unknown;
  readonly resume?: JsonValue;
  readonly strategyIndex: number;
}

export function readChannelAuthenticationPayload(
  payload: Readonly<Record<string, unknown>>,
): ChannelAuthenticationPayload | undefined {
  const value = payload[CHANNEL_AUTHENTICATION_PAYLOAD_KEY];
  if (typeof value !== "object" || value === null || !("event" in value)) return undefined;
  return value as ChannelAuthenticationPayload;
}
