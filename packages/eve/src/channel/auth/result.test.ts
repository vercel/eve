import { describe, expect, it } from "vitest";
import { sessionAuthFromResult } from "#channel/auth/result.js";

describe("sessionAuthFromResult", () => {
  it("keeps identity fields and drops channel permission extensions", () => {
    const identity = sessionAuthFromResult({
      allowAgentInfo: true,
      allowToolStubs: true,
      attributes: { team: "acme" },
      authenticator: "oidc",
      issuer: "https://oidc.vercel.com/acme",
      principalId: "https://oidc.vercel.com/acme:runner",
      principalType: "service",
      subject: "runner",
    } as Parameters<typeof sessionAuthFromResult>[0]);

    expect(identity).toEqual({
      attributes: { team: "acme" },
      authenticator: "oidc",
      issuer: "https://oidc.vercel.com/acme",
      principalId: "https://oidc.vercel.com/acme:runner",
      principalType: "service",
      subject: "runner",
    });
  });

  it("omits absent optional fields instead of writing undefined keys", () => {
    const identity = sessionAuthFromResult({
      attributes: {},
      authenticator: "local-dev",
      principalId: "local-dev",
      principalType: "local-dev",
    });

    expect(Object.keys(identity).sort()).toEqual([
      "attributes",
      "authenticator",
      "principalId",
      "principalType",
    ]);
  });
});
