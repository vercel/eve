import { describe, expect, it } from "vitest";

import { ClientError } from "#client/client-error.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
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

describe("formatVercelAuthChallengeMessage", () => {
  it("renders the target URL and the supported escape hatches", () => {
    const message = formatVercelAuthChallengeMessage({
      serverUrl: "https://example.vercel.app",
    });

    expect(message).toContain("https://example.vercel.app");
    expect(message).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(message).toContain("Disable Deployment Protection");
    // Documentation pointer keeps the message actionable when neither
    // escape hatch fits the user's setup.
    expect(message).toContain("https://vercel.com/docs/deployment-protection");
  });

  it("does not include the raw HTML challenge body", () => {
    const message = formatVercelAuthChallengeMessage({
      serverUrl: "https://example.vercel.app",
    });

    expect(message).not.toContain("<");
    expect(message).not.toContain("doctype");
  });
});
