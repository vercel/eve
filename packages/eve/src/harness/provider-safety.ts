import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type { ModelProfile } from "#harness/model-profile.js";
import type { HarnessSession } from "#harness/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
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
  readonly profile: ModelProfile;
  readonly providerOptions: Readonly<Record<string, unknown>> | undefined;
  readonly session: Pick<HarnessSession, "rootSessionId" | "sessionId">;
}): Record<string, unknown> | undefined {
  const { session } = input;
  const providerOptions = mergeProviderSafetyIdentifier(
    input.profile.provider,
    input.providerOptions,
    input.auth,
  );
  if (input.profile.gateway) {
    return mergeGatewaySessionId(
      providerOptions,
      resolveConversationId(session.rootSessionId ?? session.sessionId),
    );
  }
  return input.profile.provider === "openai"
    ? mergeOpenAIPromptCacheKey(providerOptions, session.sessionId)
    : providerOptions;
}

/**
 * OpenAI uses the cache key to route requests that share a prompt prefix toward the same cache,
 * and matches less reliably without one. Each session keeps its own prefix, so its id makes the key. The hash
 * keeps the key short and opaque whatever the session id looks like.
 */
function mergeOpenAIPromptCacheKey(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  sessionId: string,
): Record<string, unknown> {
  const promptCacheKey = createHash("sha256").update(sessionId, "utf8").digest("base64url");
  return mergeObjects({ openai: { promptCacheKey } }, providerOptions);
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
