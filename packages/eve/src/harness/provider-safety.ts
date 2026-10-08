import type { SessionAuthContext } from "#channel/types.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { mergeObjects } from "#shared/objects.js";

/**
 * Adds a provider-specific end-user safety identifier without disclosing the
 * raw eve principal. Authored provider options take precedence over the default.
 */
export function mergeProviderSafetyIdentifier(
  provider: string,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  auth: SessionAuthContext | null,
): Record<string, unknown> | undefined {
  if (auth === null) {
    return providerOptions;
  }

  const ownerKey = invocationOwnerKey(auth);
  const defaults =
    provider === "openai"
      ? { openai: { safetyIdentifier: ownerKey } }
      : provider === "anthropic"
        ? { anthropic: { metadata: { userId: ownerKey } } }
        : undefined;

  return defaults === undefined ? providerOptions : mergeObjects(defaults, providerOptions);
}

/** Composes the per-call defaults shared by model steps and compaction. */
export function resolveCallProviderOptions(input: {
  readonly auth: SessionAuthContext | null;
  readonly conversationId: string;
  readonly profile: ModelProfile;
  readonly providerOptions: Readonly<Record<string, unknown>> | undefined;
}): Record<string, unknown> | undefined {
  const providerOptions = mergeProviderSafetyIdentifier(
    input.profile.provider,
    input.providerOptions,
    input.auth,
  );
  return input.profile.gateway
    ? mergeGatewaySessionId(providerOptions, input.conversationId)
    : providerOptions;
}

/** Groups Gateway generations under the same identity used by eve's agent spans. */
function mergeGatewaySessionId(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  conversationId: string,
): Record<string, unknown> | undefined {
  const gateway = providerOptions?.gateway;
  const gatewayOptions =
    gateway !== null && typeof gateway === "object" && !Array.isArray(gateway)
      ? (gateway as Record<string, unknown>)
      : undefined;
  if (typeof gatewayOptions?.sessionId === "string" && gatewayOptions.sessionId.trim()) {
    return providerOptions;
  }

  return {
    ...providerOptions,
    gateway: { ...gatewayOptions, sessionId: conversationId },
  };
}
