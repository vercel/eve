import { describe, expect, it } from "vitest";

import { summarizeInstrumentationPrincipal } from "#instrumentation/principal-summary.js";

describe("summarizeInstrumentationPrincipal", () => {
  it("preserves explicit null without inventing a fingerprint", () => {
    expect(summarizeInstrumentationPrincipal(null)).toEqual({ type: "none" });
    expect(summarizeInstrumentationPrincipal(undefined)).toBeUndefined();
  });

  it("produces a deterministic pseudonymous fingerprint and bounds principal types", () => {
    const principal = {
      attributes: {},
      authenticator: "oidc",
      issuer: "https://issuer.example",
      principalId: "secret-user-id",
      principalType: "tenant-administrator",
      subject: "secret-subject",
    };
    const first = summarizeInstrumentationPrincipal(principal);
    const second = summarizeInstrumentationPrincipal(principal);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ type: "other" });
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{32}$/u);
    expect(first).not.toHaveProperty("id");
    expect(JSON.stringify(first)).not.toContain("secret");
  });
});
