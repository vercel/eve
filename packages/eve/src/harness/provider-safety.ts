import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type { ModelProfile } from "#harness/model-profile.js";
import type { HarnessSession } from "#harness/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { mergeObjects } from "#shared/objects.js";

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

export function resolveCallProviderOptions(input: {
  readonly agentTag?: string;
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
      input.agentTag === undefined
        ? providerOptions
        : mergeGatewayTag(providerOptions, input.agentTag),
      resolveConversationId(session.rootSessionId ?? session.sessionId),
    );
  }
  return PROMPT_CACHE_KEY_PROVIDERS.has(input.profile.provider)
    ? mergeOpenAIPromptCacheKey(providerOptions, session.sessionId)
    : providerOptions;
}

const PROMPT_CACHE_KEY_PROVIDERS: ReadonlySet<string> = new Set(["openai", "codex"]);

function mergeOpenAIPromptCacheKey(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  sessionId: string,
): Record<string, unknown> {
  const promptCacheKey = createHash("sha256").update(sessionId, "utf8").digest("base64url");
  return mergeObjects({ openai: { promptCacheKey } }, providerOptions);
}

const MAX_GATEWAY_TAGS = 10;

function mergeGatewayTag(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  tag: string,
): Record<string, unknown> | undefined {
  const gateway = gatewayOptionsOf(providerOptions);
  const tags: readonly unknown[] = Array.isArray(gateway?.tags) ? gateway.tags : [];
  if (tags.includes(tag) || tags.length >= MAX_GATEWAY_TAGS) return providerOptions;
  return { ...providerOptions, gateway: { ...gateway, tags: [...tags, tag] } };
}

function gatewayOptionsOf(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const gateway = providerOptions?.gateway;
  return gateway !== null && typeof gateway === "object" && !Array.isArray(gateway)
    ? (gateway as Record<string, unknown>)
    : undefined;
}

function mergeGatewaySessionId(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  conversationId: string,
): Record<string, unknown> | undefined {
  const gatewayOptions = gatewayOptionsOf(providerOptions);
  if (typeof gatewayOptions?.sessionId === "string" && gatewayOptions.sessionId.trim()) {
    return providerOptions;
  }

  return {
    ...providerOptions,
    gateway: { ...gatewayOptions, sessionId: conversationId },
  };
}
