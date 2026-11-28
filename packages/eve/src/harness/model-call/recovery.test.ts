import { describe, expect, it } from "vitest";

import { EmptyModelResponseError } from "#harness/model-call/errors.js";
import { recoverModelCall, resolveMaxOutputTokens } from "#harness/model-call/recovery.js";

function includeRejection(): Error {
  const body = {
    error: {
      message:
        "Invalid value: 'web_search_call.action.sources'. Supported values are: 'reasoning.encrypted_content'.",
      param: "include",
    },
  };
  return Object.assign(new Error(body.error.message), {
    data: body,
    isRetryable: false,
    name: "AI_APICallError",
    responseBody: JSON.stringify(body),
    statusCode: 400,
  });
}

function providerHistoryRejection(rejection: string): Error {
  const upstream = Object.assign(new Error("Bad Request"), {
    data: {
      providerAttempts: [
        { error: "Service temporarily unavailable", provider: "anthropic", statusCode: 503 },
        { error: `messages.5.content.0: ${rejection}`, provider: "claudeaws", statusCode: 400 },
      ],
    },
  });
  return Object.assign(new Error("gateway", { cause: upstream }), {
    name: "GatewayInternalServerError",
    statusCode: 400,
  });
}

const diagnostics = { sessionId: "s", turnId: "turn_0" };

describe("recoverModelCall", () => {
  it("removes rejected web search once, retaining that removal through an empty-response recovery", () => {
    const disabled = recoverModelCall(includeRejection(), {}, diagnostics)!;
    expect([...disabled.disabledProviderTools!]).toEqual(["web_search"]);
    expect(disabled.extraSystemNote).toContain("web_search");
    expect(recoverModelCall(includeRejection(), disabled, diagnostics)).toBeUndefined();

    const nudged1 = recoverModelCall(new EmptyModelResponseError(), disabled, diagnostics)!;
    expect([...nudged1.disabledProviderTools!]).toEqual(["web_search"]);
    expect(nudged1.extraSystemNote).toBe(disabled.extraSystemNote);
    expect(nudged1.trailingUserNote).toContain("Do not repeat writes");
    const nudged2 = recoverModelCall(new EmptyModelResponseError(), nudged1, diagnostics)!;
    const nudged3 = recoverModelCall(new EmptyModelResponseError(), nudged2, diagnostics)!;
    expect(recoverModelCall(new EmptyModelResponseError(), nudged3, diagnostics)).toBeUndefined();
    expect(recoverModelCall(includeRejection(), nudged1, diagnostics)).toBeUndefined();
  });

  it("carries the reasoning tail and lowers reasoning effort when recovering from a length-truncated empty response", () => {
    const error = new EmptyModelResponseError({
      finishReason: "length",
      reasoningTail: "Next step: run pytest on /app/run.py",
    });
    const recovered = recoverModelCall(error, {}, diagnostics)!;
    expect(recovered.trailingUserNote).toContain("output length limit");
    expect(recovered.trailingUserNote).toContain("Next step: run pytest on /app/run.py");
    expect(recovered.reasoningOverride).toBe("low");
  });

  it("disables an additional unsupported provider tool even when another is already cached", () => {
    const recovered = recoverModelCall(
      includeRejection(),
      { disabledProviderTools: new Set(["other_tool"]) },
      diagnostics,
    )!;
    expect([...recovered.disabledProviderTools!].sort()).toEqual(["other_tool", "web_search"]);
    expect(recoverModelCall(includeRejection(), recovered, diagnostics)).toBeUndefined();
  });

  it("steps down maxOutputTokens and falls back to omitting it if still rejected", () => {
    const error = Object.assign(new Error("max_tokens must be less than or equal to 16384"), {
      statusCode: 400,
    });
    const recovered = recoverModelCall(
      error,
      {},
      { ...diagnostics, attemptedMaxOutputTokens: 32768 },
    )!;
    expect(recovered.maxOutputTokensOverride).toBe(16384);
    const omitted = recoverModelCall(error, recovered, {
      ...diagnostics,
      attemptedMaxOutputTokens: 16384,
    })!;
    expect(omitted.maxOutputTokensOverride).toBeNull();
    expect(recoverModelCall(error, omitted, diagnostics)).toBeUndefined();
  });

  it("omits maxOutputTokens when a combined context error reports a window limit larger than the requested cap", () => {
    const error = Object.assign(new Error("prompt tokens + max_tokens exceeds maximum of 200000"), {
      statusCode: 400,
    });
    const recovered = recoverModelCall(
      error,
      {},
      { ...diagnostics, attemptedMaxOutputTokens: 32768 },
    )!;
    expect(recovered.maxOutputTokensOverride).toBeNull();
  });

  it.each([
    "Invalid encrypted_content in search_result block",
    "Input tag 'web_search_tool_result' found using 'type' does not match any of the expected tags",
  ])("removes web search once when a provider rejects its earlier results: %s", (rejection) => {
    const error = providerHistoryRejection(rejection);
    const disabled = recoverModelCall(error, {}, diagnostics)!;
    expect([...disabled.disabledProviderTools!]).toEqual(["web_search"]);
    expect(recoverModelCall(error, disabled, diagnostics)).toBeUndefined();
  });

  it("does not change a request to recover an unrelated failure", () => {
    expect(recoverModelCall(new Error("broken"), {}, diagnostics)).toBeUndefined();
  });
});

describe("resolveMaxOutputTokens", () => {
  it("clamps output tokens to available context window headroom and lower default targets", () => {
    expect(resolveMaxOutputTokens(200_000, 10_000, undefined)).toBe(32_768);
    expect(resolveMaxOutputTokens(200_000, 197_000, undefined)).toBe(3_000);
    expect(resolveMaxOutputTokens(8_192, 6_000, undefined, 8_192)).toBe(2_192);
    expect(resolveMaxOutputTokens(128_000, 10_000, 16_384, 8_192)).toBe(8_192);
    expect(resolveMaxOutputTokens(128_000, 10_000, 4_096, 8_192)).toBe(4_096);
    expect(resolveMaxOutputTokens(128_000, 10_000, null)).toBeUndefined();
  });
});
