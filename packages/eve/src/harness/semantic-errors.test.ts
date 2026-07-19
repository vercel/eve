import { describe, expect, it } from "vitest";

import { summarizeKnownError } from "./semantic-errors.js";

describe("summarizeKnownError", () => {
  it("summarizes gateway authentication failures with their catalog id", () => {
    const error = new Error(
      "AI Gateway authentication failed: Invalid API key provided. The key may be malformed or revoked.",
    );
    error.name = "GatewayAuthenticationError";

    expect(summarizeKnownError(error)).toMatchObject({
      id: "gateway-auth-invalid-api-key",
      name: "AI Gateway authentication failed",
    });
  });

  it("summarizes missing provider API keys", () => {
    const error = new Error("OpenAI API key is missing.");
    error.name = "LoadAPIKeyError";

    expect(summarizeKnownError(error)).toMatchObject({
      id: "model-provider-api-key-missing",
      name: "Model provider API key missing",
    });
  });

  it("summarizes network failures from error codes on the cause chain", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
      code: "ECONNREFUSED",
    });
    const error = new TypeError("fetch failed", { cause });

    expect(summarizeKnownError(error)).toEqual({
      id: "network-request-failed",
      name: "Network request failed",
      message: expect.stringContaining("ECONNREFUSED") as string,
    });
  });

  it("summarizes bare fetch failures without a structured code", () => {
    expect(summarizeKnownError(new TypeError("fetch failed"))).toMatchObject({
      id: "network-request-failed",
    });
  });

  it("does not sweep in errors that merely mention networking", () => {
    expect(summarizeKnownError(new Error("network configuration invalid"))).toBeNull();
  });

  it("returns null for unrecognized errors and non-error throwables", () => {
    expect(summarizeKnownError(new Error("something else went wrong"))).toBeNull();
    expect(summarizeKnownError("string throw")).toBeNull();
    expect(summarizeKnownError(null)).toBeNull();
    expect(summarizeKnownError(undefined)).toBeNull();
  });
});
