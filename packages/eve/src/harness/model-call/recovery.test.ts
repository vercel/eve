import { describe, expect, it } from "vitest";

import { EmptyModelResponseError } from "#harness/model-call/errors.js";
import { recoverModelCall } from "#harness/model-call/recovery.js";

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

  it("lowers maxOutputTokens once when a provider rejects the requested output limit", () => {
    const error = Object.assign(new Error("max_tokens must be less than or equal to 16384"), {
      statusCode: 400,
    });
    const recovered = recoverModelCall(error, {}, diagnostics)!;
    expect(recovered.maxOutputTokensOverride).toBe(16384);
    expect(recoverModelCall(error, recovered, diagnostics)).toBeUndefined();
  });

  it("does not change a request to recover an unrelated failure", () => {
    expect(recoverModelCall(new Error("broken"), {}, diagnostics)).toBeUndefined();
  });
});
