import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { isContextOverflowError } from "#harness/model-call/errors.js";

function apiCallError(statusCode: number, body: object): APICallError {
  const responseBody = JSON.stringify(body);
  return new APICallError({
    data: body,
    isRetryable: false,
    message: "Bad Request",
    requestBodyValues: {},
    responseBody,
    statusCode,
    url: "https://api.example.com/v1",
  });
}

describe("isContextOverflowError", () => {
  it("recognizes Anthropic's prompt is too long", () => {
    const error = apiCallError(400, {
      error: {
        message: "prompt is too long: 208310 tokens > 200000 maximum",
        type: "invalid_request_error",
      },
      type: "error",
    });
    expect(isContextOverflowError(error)).toBe(true);
  });

  it("recognizes OpenAI's context_length_exceeded", () => {
    const error = apiCallError(400, {
      error: {
        code: "context_length_exceeded",
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
        param: "messages",
        type: "invalid_request_error",
      },
    });
    expect(isContextOverflowError(error)).toBe(true);
  });

  it("recognizes OpenAI Responses' input exceeds the context window", () => {
    const error = apiCallError(400, {
      error: {
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
        type: "invalid_request_error",
      },
    });
    expect(isContextOverflowError(error)).toBe(true);
  });

  it("recognizes an AI Gateway invalid request wrapping the provider's rejection", () => {
    const upstream = apiCallError(400, {
      error: { message: "prompt is too long: 1000000 tokens > 200000 maximum" },
    });
    const gateway = Object.assign(
      new Error("Invalid request: prompt is too long: 1000000 tokens > 200000 maximum", {
        cause: upstream,
      }),
      { name: "GatewayInvalidRequestError", statusCode: 400, type: "invalid_request_error" },
    );
    expect(isContextOverflowError(gateway)).toBe(true);
  });

  it("recognizes a 413 request too large", () => {
    expect(
      isContextOverflowError(apiCallError(413, { error: { message: "Request too large" } })),
    ).toBe(true);
  });

  it("ignores rate limits and other rejections", () => {
    const rateLimit = apiCallError(429, {
      error: {
        code: "rate_limit_exceeded",
        message: "Request too large for gpt-4o: Limit 30000, Requested 45000 tokens per min.",
      },
    });
    expect(isContextOverflowError(rateLimit)).toBe(false);
    expect(
      isContextOverflowError(apiCallError(400, { error: { message: "messages: field required" } })),
    ).toBe(false);
    expect(
      isContextOverflowError(apiCallError(401, { error: { message: "invalid x-api-key" } })),
    ).toBe(false);
    expect(isContextOverflowError(new Error("socket hang up"))).toBe(false);
  });
});
