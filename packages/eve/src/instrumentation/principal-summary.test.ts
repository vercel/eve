import { afterEach, describe, expect, it, vi } from "vitest";

import { summarizeInstrumentationPrincipal } from "#instrumentation/principal-summary.js";

const principal = {
  attributes: { email: "private@example.com" },
  authenticator: "oidc",
  issuer: "https://issuer.example",
  principalId: "secret-user-id",
  principalType: "tenant-administrator",
  subject: "secret-subject",
};

const contentContext = (
  audience: "public" | "private" | "unknown",
  environment: "development" | "preview" | "production" = "production",
) => ({ audience, environment });

describe("summarizeInstrumentationPrincipal", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits oversized IDs without truncating or changing authentication records", () => {
    const oversized = { ...principal, principalId: "x".repeat(1025) };
    expect(summarizeInstrumentationPrincipal(oversized, contentContext("public"))).toEqual({
      type: "other",
    });
    expect(oversized.principalId).toHaveLength(1025);
    expect(
      summarizeInstrumentationPrincipal(
        {
          ...principal,
          principalId: String.fromCodePoint(0x1f600).repeat(300),
        },
        contentContext("public"),
      ),
    ).toEqual({ type: "other" });
  });

  it("preserves none and bounds authored principal types", () => {
    expect(summarizeInstrumentationPrincipal(null, contentContext("public"))).toEqual({
      type: "none",
    });
    expect(summarizeInstrumentationPrincipal(undefined, contentContext("public"))).toBeUndefined();
    expect(summarizeInstrumentationPrincipal(principal, contentContext("public"))).toEqual({
      id: "secret-user-id",
      type: "other",
    });
    expect(
      summarizeInstrumentationPrincipal(
        { ...principal, principalType: "runtime" },
        contentContext("public"),
      ),
    ).toEqual({ id: "secret-user-id", type: "runtime" });
    expect(
      summarizeInstrumentationPrincipal(
        { ...principal, principalType: "unknown" },
        contentContext("public"),
      ),
    ).toEqual({ id: "secret-user-id", type: "unknown" });
  });

  it("omits IDs when the audience is not content-visible", () => {
    expect(summarizeInstrumentationPrincipal(principal, contentContext("private"))).toEqual({
      type: "other",
    });
    expect(summarizeInstrumentationPrincipal(principal, contentContext("unknown"))).toEqual({
      type: "other",
    });
  });

  it("follows the explicit development rule for unknown audiences", () => {
    expect(
      summarizeInstrumentationPrincipal(principal, contentContext("unknown", "development")),
    ).toEqual({
      id: "secret-user-id",
      type: "other",
    });
  });

  it("never includes claims or principal attributes", () => {
    const summary = summarizeInstrumentationPrincipal(principal, contentContext("public"));

    expect(summary).not.toHaveProperty("attributes");
    expect(summary).not.toHaveProperty("issuer");
    expect(summary).not.toHaveProperty("subject");
    expect(JSON.stringify(summary)).not.toContain("private@example.com");
    expect(JSON.stringify(summary)).not.toContain("secret-subject");
  });
});
