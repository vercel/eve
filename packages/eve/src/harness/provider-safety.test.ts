import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { mergeProviderSafetyIdentifier } from "#harness/provider-safety.js";
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

    expect(
      mergeProviderSafetyIdentifier({ id: "openai/gpt-5.6-sol" }, providerOptions, auth),
    ).toEqual(providerOptions);
  });

  it("treats an authored OpenAI null as explicit", () => {
    const providerOptions = { openai: { safetyIdentifier: null } };

    expect(
      mergeProviderSafetyIdentifier({ id: "openai/gpt-5.6-sol" }, providerOptions, auth),
    ).toEqual(providerOptions);
  });

  it("sets the OpenAI safety identifier while preserving other options", () => {
    const result = mergeProviderSafetyIdentifier(
      { id: "openai/gpt-5.6-sol" },
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

    expect(
      mergeProviderSafetyIdentifier({ id: "anthropic/claude-opus-5" }, providerOptions, auth),
    ).toEqual(providerOptions);
  });

  it("sets the Anthropic user ID while preserving other options", () => {
    const result = mergeProviderSafetyIdentifier(
      { id: "anthropic/claude-opus-5" },
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

    expect(
      mergeProviderSafetyIdentifier({ id: "google/gemini-3.1-pro" }, providerOptions, auth),
    ).toBe(providerOptions);
  });

  it("does not add a safety identifier without an active caller", () => {
    const providerOptions = { anthropic: { thinking: { type: "adaptive" } } };

    expect(
      mergeProviderSafetyIdentifier({ id: "anthropic/claude-opus-5" }, providerOptions, null),
    ).toBe(providerOptions);
  });
});
