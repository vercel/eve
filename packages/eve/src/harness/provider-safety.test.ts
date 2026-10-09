import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { ModelProfile } from "#harness/model-profile.js";
import {
  mergeProviderSafetyIdentifier,
  resolveCallProviderOptions,
} from "#harness/provider-safety.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";

const auth: SessionAuthContext = {
  attributes: { email: "user@example.com" },
  authenticator: "oidc",
  issuer: "https://issuer.example.com",
  principalId: "user_123",
  principalType: "user",
  subject: "subject_123",
};

describe("mergeProviderSafetyIdentifier", () => {
  it("preserves an authored OpenAI safety identifier", () => {
    const providerOptions = {
      gateway: { caching: "auto" },
      openai: { safetyIdentifier: "authored", store: false },
    };

    expect(mergeProviderSafetyIdentifier("openai", providerOptions, auth)).toEqual(providerOptions);
  });

  it("treats an authored OpenAI null as explicit", () => {
    const providerOptions = { openai: { safetyIdentifier: null } };

    expect(mergeProviderSafetyIdentifier("openai", providerOptions, auth)).toEqual(providerOptions);
  });

  it("sets the OpenAI safety identifier while preserving other options", () => {
    const result = mergeProviderSafetyIdentifier(
      "openai",
      {
        gateway: { caching: "auto" },
        openai: { store: false },
      },
      auth,
    );

    expect(result).toEqual({
      gateway: { caching: "auto" },
      openai: {
        safetyIdentifier: invocationOwnerKey(auth),
        store: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(auth.principalId);
  });

  it("preserves an authored Anthropic user ID", () => {
    const providerOptions = {
      anthropic: {
        metadata: { userId: "authored" },
        thinking: { type: "adaptive" },
      },
    };

    expect(mergeProviderSafetyIdentifier("anthropic", providerOptions, auth)).toEqual(
      providerOptions,
    );
  });

  it("sets the Anthropic user ID while preserving other options", () => {
    const result = mergeProviderSafetyIdentifier(
      "anthropic",
      {
        gateway: { caching: "auto" },
        anthropic: { thinking: { type: "adaptive" } },
      },
      auth,
    );

    expect(result).toEqual({
      gateway: { caching: "auto" },
      anthropic: {
        metadata: { userId: invocationOwnerKey(auth) },
        thinking: { type: "adaptive" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(auth.principalId);
  });

  it("does not add a safety identifier for another provider", () => {
    const providerOptions = { google: { structuredOutputs: true } };

    expect(mergeProviderSafetyIdentifier("google", providerOptions, auth)).toBe(providerOptions);
  });

  it("does not add a safety identifier without an active caller", () => {
    const providerOptions = { anthropic: { thinking: { type: "adaptive" } } };

    expect(mergeProviderSafetyIdentifier("anthropic", providerOptions, null)).toBe(providerOptions);
  });
});

describe("resolveCallProviderOptions", () => {
  const openai: ModelProfile = {
    anthropicCache: false,
    filesOutsideToolResults: false,
    gateway: false,
    googleSearchDropsTools: false,
    provider: "openai",
  };
  const resolve = (
    profile: ModelProfile,
    providerOptions?: Record<string, unknown>,
    sessionId = "session-1",
  ) =>
    resolveCallProviderOptions({
      auth: null,
      conversationId: "conversation-1",
      profile,
      providerOptions,
      sessionId,
    });

  it("keys a direct OpenAI call's prompt cache to its session", () => {
    const key = (resolve(openai) as { openai: { promptCacheKey: string } }).openai.promptCacheKey;

    expect(key).toMatch(/^[\w-]{43}$/);
    expect(resolve(openai)).toEqual({ openai: { promptCacheKey: key } });
    expect(resolve(openai, undefined, "session-2")).not.toEqual({
      openai: { promptCacheKey: key },
    });
  });

  it("preserves an authored OpenAI prompt cache key", () => {
    const providerOptions = { openai: { promptCacheKey: "authored", store: false } };

    expect(resolve(openai, providerOptions)).toEqual(providerOptions);
  });

  it("leaves Gateway and other providers to their own cache routing", () => {
    expect(resolve({ ...openai, gateway: true })).toEqual({
      gateway: { sessionId: "conversation-1" },
    });
    expect(resolve({ ...openai, provider: "anthropic" })).toBeUndefined();
  });
});
