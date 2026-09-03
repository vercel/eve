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

describe("summarizeInstrumentationPrincipal", () => {
  it("preserves none and bounds authored principal types", () => {
    expect(summarizeInstrumentationPrincipal(null, "public")).toEqual({
      type: "none",
    });
    expect(summarizeInstrumentationPrincipal(undefined, "public")).toBeUndefined();
    expect(summarizeInstrumentationPrincipal(principal, "public")).toEqual({
      id: "secret-user-id",
      type: "other",
    });
    expect(
      summarizeInstrumentationPrincipal({ ...principal, principalType: "runtime" }, "public"),
    ).toEqual({ id: "secret-user-id", type: "runtime" });
  });

  it("omits IDs when the audience is not content-visible", () => {
    expect(summarizeInstrumentationPrincipal(principal, "private")).toEqual({
      type: "other",
    });
    expect(summarizeInstrumentationPrincipal(principal, "unknown")).toEqual({
      type: "other",
    });
  });

  it("follows the existing local-development rule for unknown audiences", () => {
    vi.stubEnv("EVE_DEV", "1");

    expect(summarizeInstrumentationPrincipal(principal, "unknown")).toEqual({
      id: "secret-user-id",
      type: "other",
    });
  });

  it("never includes claims or principal attributes", () => {
    const summary = summarizeInstrumentationPrincipal(principal, "public");

    expect(summary).not.toHaveProperty("attributes");
    expect(summary).not.toHaveProperty("issuer");
    expect(summary).not.toHaveProperty("subject");
    expect(JSON.stringify(summary)).not.toContain("private@example.com");
    expect(JSON.stringify(summary)).not.toContain("secret-subject");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
