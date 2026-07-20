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
const VERCEL_SSO_URL = "https://vercel.com/sso-api?url=https%3A%2F%2Fexample.vercel.app&nonce=test";
const VERCEL_PROTECTED_DEPLOYMENT_BODY = JSON.stringify({
  error: { code: "401", message: "Protected deployment" },
  protection: {
    auto_vercel_auth_redirect: true,
    password_enabled: false,
    vercel_auth_enabled: true,
    vercel_auth_callback: VERCEL_SSO_URL,
  },
});

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

  it("detects the manual-redirect response returned by Vercel for GET requests", () => {
    expect(
      isVercelAuthChallenge(new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL })),
    ).toBe(true);
    expect(
      isVercelAuthChallenge({
        body: "Redirecting...",
        headers: { Location: VERCEL_SSO_URL },
        status: 302,
      }),
    ).toBe(true);
  });

  it("detects the structured 401 returned by Vercel for API requests", () => {
    expect(isVercelAuthChallenge(new ClientError(401, VERCEL_PROTECTED_DEPLOYMENT_BODY))).toBe(
      true,
    );
    expect(isVercelAuthChallenge({ body: VERCEL_PROTECTED_DEPLOYMENT_BODY, status: 401 })).toBe(
      true,
    );
  });

  it("detects Vercel's credentialed deployment-protection rejection", () => {
    expect(
      isVercelAuthChallenge(
        new ClientError(401, "You must sign in\n\nUNAUTHORIZED\n\niad1::request-id\n", {
          "x-vercel-error": "UNAUTHORIZED",
        }),
      ),
    ).toBe(true);
  });

  it("requires HTTP 401 and the complete legacy HTML challenge signature", () => {
    expect(isVercelAuthChallenge(new ClientError(500, VERCEL_SSO_CHALLENGE_BODY))).toBe(false);
    expect(
      isVercelAuthChallenge(new ClientError(401, "<title>Authentication Required</title>")),
    ).toBe(false);
    expect(isVercelAuthChallenge({ body: VERCEL_SSO_CHALLENGE_BODY })).toBe(false);
  });

  it("requires an exact Vercel SSO destination for redirect challenges", () => {
    expect(
      isVercelAuthChallenge(
        new ClientError(302, "Redirecting...", {
          location: "https://example.com/sso-api?url=https://eve.test",
        }),
      ),
    ).toBe(false);
    expect(
      isVercelAuthChallenge(
        new ClientError(302, "Redirecting...", {
          location: "https://vercel.com/sso-api",
        }),
      ),
    ).toBe(false);
    expect(
      isVercelAuthChallenge(new ClientError(200, "Redirecting...", { location: VERCEL_SSO_URL })),
    ).toBe(false);
  });

  it("requires the complete structured Vercel challenge signature", () => {
    expect(
      isVercelAuthChallenge(
        new ClientError(
          401,
          JSON.stringify({
            error: { code: "401", message: "Protected deployment" },
            protection: {
              vercel_auth_callback: "https://example.com/sso-api?url=https://eve.test",
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isVercelAuthChallenge(
        new ClientError(401, JSON.stringify({ error: "Protected deployment" })),
      ),
    ).toBe(false);
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
