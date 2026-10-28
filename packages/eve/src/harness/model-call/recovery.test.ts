import { describe, expect, it } from "vitest";

import { EmptyModelResponseError } from "#harness/model-call/errors.js";
import { recoverModelCall } from "#harness/model-call/recovery.js";

/** Bedrock Mantle's response when a request carries OpenAI web search. */
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

    const nudged = recoverModelCall(new EmptyModelResponseError(), disabled, diagnostics)!;
    expect([...nudged.disabledProviderTools!]).toEqual(["web_search"]);
    expect(nudged.extraSystemNote).toBe(disabled.extraSystemNote);
    expect(nudged.trailingUserNote).toContain("Do not repeat writes");
    expect(recoverModelCall(new EmptyModelResponseError(), nudged, diagnostics)).toBeUndefined();
    expect(recoverModelCall(includeRejection(), nudged, diagnostics)).toBeUndefined();
  });

  it("does not change a request to recover an unrelated failure", () => {
    expect(recoverModelCall(new Error("broken"), {}, diagnostics)).toBeUndefined();
  });
});
