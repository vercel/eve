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

    const nudged = recoverModelCall(new EmptyModelResponseError(), disabled, diagnostics)!;
    expect([...nudged.disabledProviderTools!]).toEqual(["web_search"]);
    expect(nudged.extraSystemNote).toBe(disabled.extraSystemNote);
    expect(nudged.trailingUserNote).toContain("Do not repeat writes");
    expect(recoverModelCall(new EmptyModelResponseError(), nudged, diagnostics)).toBeUndefined();
    expect(recoverModelCall(includeRejection(), nudged, diagnostics)).toBeUndefined();
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
