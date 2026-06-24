import { describe, expect, it } from "vitest";

import { ClientError } from "#client/client-error.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";

/**
 * Trimmed sample that mirrors the markup Vercel ships on a
 * Deployment Protection SSO challenge. The full body is several
 * kilobytes; we keep just the markers `isVercelAuthChallenge`
 * relies on.
 */
const VERCEL_SSO_CHALLENGE_BODY = `<!doctype html><html lang=en><meta charset=utf-8>
<title>Authentication Required</title>
<noscript><meta http-equiv=refresh content="1; URL=https://vercel.com/sso-api?url=https%3A%2F%2Fexample.vercel.app"></noscript>
<a href="https://vercel.com/sso-api?url=https%3A%2F%2Fexample.vercel.app">redirect</a>
<a href="https://vercel.com/security">Vercel Authentication</a>
</html>`;

describe("isVercelAuthChallenge", () => {
  it("detects a real ClientError carrying the Vercel SSO challenge body", () => {
    expect(isVercelAuthChallenge(new ClientError(401, VERCEL_SSO_CHALLENGE_BODY))).toBe(true);
  });

  it("detects a duck-typed error with the same body shape (post-IPC)", () => {
    // ClientErrors that cross a boundary (e.g. a worker thread, a
    // structured-clone deserialization, a TypeScript-erased plain
    // object) lose their prototype but keep the `body` field.
    expect(isVercelAuthChallenge({ body: VERCEL_SSO_CHALLENGE_BODY, status: 401 })).toBe(true);
  });

  it("requires HTTP 401 and the complete Vercel challenge signature", () => {
    expect(isVercelAuthChallenge(new ClientError(500, VERCEL_SSO_CHALLENGE_BODY))).toBe(false);
    expect(
      isVercelAuthChallenge(new ClientError(401, "<title>Authentication Required</title>")),
    ).toBe(false);
    expect(isVercelAuthChallenge({ body: VERCEL_SSO_CHALLENGE_BODY })).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isVercelAuthChallenge(undefined)).toBe(false);
    expect(isVercelAuthChallenge(null)).toBe(false);
    expect(isVercelAuthChallenge("oops")).toBe(false);
    expect(isVercelAuthChallenge({})).toBe(false);
    expect(isVercelAuthChallenge({ body: 42 })).toBe(false);
  });

  it("returns false for an empty body", () => {
    expect(isVercelAuthChallenge(new ClientError(401, ""))).toBe(false);
  });

  it("returns false for an arbitrary HTML error body without Vercel markers", () => {
    expect(
      isVercelAuthChallenge(
        new ClientError(500, "<html><body>Internal Server Error</body></html>"),
      ),
    ).toBe(false);
  });

  it("returns false for a JSON error body the framework would normally throw", () => {
    expect(isVercelAuthChallenge(new ClientError(400, '{"error":"Invalid JSON body."}'))).toBe(
      false,
    );
  });
});

describe("vercelTrustedSourcesErrorCode", () => {
  it("extracts the stable code without retaining the request id", () => {
    expect(
      vercelTrustedSourcesErrorCode(
        [
          "The caller environment is not permitted.",
          "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
          "iad1::request-id",
        ].join("\n\n"),
      ),
    ).toBe("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH");
  });

  it("returns undefined for an unrelated error", () => {
    expect(vercelTrustedSourcesErrorCode("Unavailable")).toBeUndefined();
  });

  it("includes invalid local OIDC claims in the repair context", () => {
    const message = formatVercelAuthChallengeMessage({
      serverUrl: "https://example.vercel.app",
      oidcTokenFailure: {
        kind: "invalid-claims",
        invalidClaims: ["owner_id", "project_id"],
      },
    });

    expect(message).toContain("invalid claims");
    expect(message).toContain("owner_id");
    expect(message).toContain("project_id");
  });

  it("identifies the claims that do not match the resolved target", () => {
    const message = formatVercelAuthChallengeMessage({
      serverUrl: "https://example.vercel.app",
      oidcTokenFailure: {
        kind: "target-mismatch",
        mismatchedClaims: ["owner_id", "project_id"],
      },
    });

    expect(message).toContain("owner_id");
    expect(message).toContain("project_id");
  });
});
