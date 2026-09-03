import { describe, expect, it } from "vitest";

import { summarizeInstrumentationPrincipal } from "#instrumentation/principal-summary.js";

describe("summarizeInstrumentationPrincipal", () => {
  it("preserves explicit null without inventing a fingerprint", () => {
    expect(summarizeInstrumentationPrincipal(null)).toEqual({ type: "none" });
    expect(summarizeInstrumentationPrincipal(undefined)).toBeUndefined();
  });

  it("produces a deterministic bounded pseudonym", () => {
    const principal = {
      attributes: {},
      authenticator: "oidc",
      issuer: "https://issuer.example",
      principalId: "secret-user-id",
      principalType: "tenant-administrator",
      subject: "secret-subject",
    };
    const summary = summarizeInstrumentationPrincipal(principal);

    expect(summary).toEqual(summarizeInstrumentationPrincipal(principal));
    expect(summary).toMatchObject({ type: "other" });
    expect(summary?.fingerprint).toMatch(/^[0-9a-f]{32}$/u);
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
