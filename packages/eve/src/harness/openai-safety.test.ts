import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { mergeOpenAISafetyIdentifier } from "#harness/openai-safety.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";

const auth: SessionAuthContext = {
  attributes: { email: "user@example.com" },
  authenticator: "oidc",
  issuer: "https://issuer.example.com",
  principalId: "user_123",
  principalType: "user",
  subject: "subject_123",
};

describe("mergeOpenAISafetyIdentifier", () => {
  it("sets a fingerprint of the active caller while preserving OpenAI options", () => {
    const result = mergeOpenAISafetyIdentifier(
      { id: "openai/gpt-5.6-sol" },
      {
        gateway: { caching: "auto" },
        openai: { safetyIdentifier: "authored", store: false },
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

  it("does not add the OpenAI option to another provider", () => {
    const providerOptions = { anthropic: { effort: "high" } };

    expect(
      mergeOpenAISafetyIdentifier({ id: "anthropic/claude-opus-4.8" }, providerOptions, auth),
    ).toBe(providerOptions);
  });

  it("does not add a safety identifier without an active caller", () => {
    const providerOptions = { openai: { store: false } };

    expect(mergeOpenAISafetyIdentifier({ id: "openai/gpt-5.6-sol" }, providerOptions, null)).toBe(
      providerOptions,
    );
  });
});
