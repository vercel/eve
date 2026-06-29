import { describe, expect, it } from "vitest";

import type { VercelCaptureFailure } from "#setup/primitives/index.js";

import {
  isConflictApiFailure,
  isForbiddenApiFailure,
  isNotFoundApiFailure,
  normalizeVercelApiResult,
} from "./vercel-api-failure.js";

function failure(input: Partial<VercelCaptureFailure>): VercelCaptureFailure {
  return {
    code: 1,
    message: "vercel api exited with code 1.",
    stderr: "",
    stdout: "",
    ...input,
  };
}

describe("Vercel API failure classification", () => {
  it("classifies structured resource errors", () => {
    expect(
      isNotFoundApiFailure(failure({ stdout: JSON.stringify({ error: { code: "not_found" } }) })),
    ).toBe(true);
    expect(
      isConflictApiFailure(failure({ stdout: JSON.stringify({ error: { code: "conflict" } }) })),
    ).toBe(true);
    expect(
      isForbiddenApiFailure(failure({ stdout: JSON.stringify({ error: { code: "forbidden" } }) })),
    ).toBe(true);
    expect(
      isForbiddenApiFailure(
        failure({ stdout: JSON.stringify({ error: { code: "team_unauthorized" } }) }),
      ),
    ).toBe(true);
  });

  it("normalizes a structured error returned after a zero process exit", () => {
    const result = normalizeVercelApiResult({
      ok: true,
      stdout: JSON.stringify({ error: { code: "forbidden", message: "Team access denied" } }),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { message: "Vercel API request failed: Team access denied." },
    });
    if (result.ok) throw new Error("Expected a normalized API failure");
    expect(isForbiddenApiFailure(result.failure)).toBe(true);
  });

  it("classifies the Vercel CLI's stderr-only resource errors", () => {
    expect(isNotFoundApiFailure(failure({ stderr: "Error: Project not found. (404)" }))).toBe(true);
    expect(isConflictApiFailure(failure({ stderr: "Error: Project already exists. (409)" }))).toBe(
      true,
    );
  });

  it("does not infer an HTTP status from the process exit code or command text", () => {
    const operational = failure({
      code: 403,
      message: "vercel api /v13/deployments/preview-404.example.com exited with code 403.",
    });

    expect(isNotFoundApiFailure(operational)).toBe(false);
    expect(isConflictApiFailure(operational)).toBe(false);
    expect(isForbiddenApiFailure(operational)).toBe(false);
    expect(isForbiddenApiFailure(failure({ stderr: "Project association failed." }))).toBe(false);
  });

  it("recognizes an explicit SSO diagnostic from stderr", () => {
    expect(
      isForbiddenApiFailure(failure({ stderr: "This team requires SAML Single Sign-On." })),
    ).toBe(true);
  });
});
