import { describe, expect, it, vi } from "vitest";

import type { HarnessStepResult } from "#harness/step-hooks.js";
import { recoverModelCall } from "#harness/model-call/recovery.js";

/** What a recovery reissues its call with. */
type RecoveryOptions = Parameters<Parameters<typeof recoverModelCall>[0]["call"]>[0];

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

describe("recoverModelCall", () => {
  it("reissues the call without web search when an OpenAI-compatible endpoint rejects it", async () => {
    const result = {} as HarnessStepResult;
    const call = vi.fn(async (_options: RecoveryOptions) => result);

    await expect(
      recoverModelCall({ call, error: includeRejection(), sessionId: "s", turnId: "turn_0" }),
    ).resolves.toEqual({ result });
    expect(call).toHaveBeenCalledOnce();
    const [options] = call.mock.calls[0]!;
    expect([...(options.disabledProviderTools ?? [])]).toEqual(["web_search"]);
    expect(options.extraSystemNote).toContain("web_search");
  });

  it("returns the error when the reissue fails too", async () => {
    const retryError = includeRejection();
    const call = vi.fn(async () => {
      throw retryError;
    });

    await expect(
      recoverModelCall({ call, error: includeRejection(), sessionId: "s", turnId: "turn_0" }),
    ).resolves.toEqual({ error: retryError });
    expect(call).toHaveBeenCalledOnce();
  });
});
