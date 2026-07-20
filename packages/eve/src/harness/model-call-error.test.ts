import { describe, expect, it } from "vitest";

import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
  normalizeModelStreamError,
  summarizeKnownModelCallConfigError,
  summarizeKnownModelCallRequestError,
} from "#harness/model-call-error.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Builds the shape `ai@7.0.0-canary.169+` rejects with when a model
 * stream closes after metadata without output (vercel/ai#15938),
 * matched by name like the real error after `toError` coercion.
 */
function noOutputGeneratedError(): Error {
  const error = new Error("No output generated. The model stream ended without a finish chunk.");
  error.name = "AI_NoOutputGeneratedError";
  return error;
}

/**
 * Builds a fake `GatewayAuthenticationError` shape matching what
 * `@ai-sdk/gateway` produces, so we can exercise the three-way
 * disambiguation in `summarizeKnownModelCallConfigError` without
 * importing the upstream class.
 */
function gatewayAuthError(message: string): Error {
  const error = new Error(message);
  error.name = "GatewayAuthenticationError";
  return error;
}

function gatewayModelCallError(input: {
  readonly gatewayName?: string;
  readonly gatewayType?: string;
  readonly statusCode?: number;
  readonly upstreamMessage?: string;
  readonly upstreamStatusCode?: number;
  readonly upstreamType?: string;
}): Error {
  const upstreamMessage = input.upstreamMessage ?? "Bad Request";
  const responseBody = JSON.stringify({
    error: {
      message: upstreamMessage,
      type: input.upstreamType,
    },
    generationId: "gen_test",
  });
  const upstream = Object.assign(new Error("[object Object]"), {
    data: {
      error: {
        message: upstreamMessage,
        type: input.upstreamType,
      },
      generationId: "gen_test",
    },
    isRetryable: false,
    name: "AI_APICallError",
    requestBodyValues: {
      tools: [{ inputSchema: { description: "large schema ".repeat(500) } }],
    },
    responseBody,
    statusCode: input.upstreamStatusCode ?? input.statusCode,
  });
  const error = Object.assign(
    new Error(`${input.gatewayName ?? "Gateway"}: ${upstreamMessage}`, { cause: upstream }),
    {
      generationId: "gen_test",
      isRetryable: false,
      name: input.gatewayName ?? "GatewayInternalServerError",
      statusCode: input.statusCode,
      type: input.gatewayType,
    },
  );
  return error;
}

function directApiCallError(input: {
  readonly data?: Record<string, unknown>;
  readonly message?: string;
  readonly responseBody?: string;
  readonly statusCode?: number;
}): Error {
  return Object.assign(new Error(input.message ?? "AI_APICallError"), {
    data: input.data,
    isRetryable: false,
    name: "AI_APICallError",
    responseBody: input.responseBody,
    statusCode: input.statusCode,
  });
}

describe("isNoOutputGeneratedError", () => {
  it("matches the AI SDK error by name", () => {
    expect(isNoOutputGeneratedError(noOutputGeneratedError())).toBe(true);
  });

  it("matches when nested in a cause chain", () => {
    const wrapped = new Error("stream failed", { cause: noOutputGeneratedError() });
    expect(isNoOutputGeneratedError(wrapped)).toBe(true);
  });

  it("matches a prototype-stripped plain-object shape", () => {
    // toError copies `name` onto a fresh Error for structured-clone
    // survivors; the raw plain object must match too.
    expect(
      isNoOutputGeneratedError({
        message: "No output generated.",
        name: "AI_NoOutputGeneratedError",
      }),
    ).toBe(true);
  });

  it("rejects other errors and non-objects", () => {
    expect(isNoOutputGeneratedError(new Error("No output generated."))).toBe(false);
    expect(isNoOutputGeneratedError(gatewayAuthError("denied"))).toBe(false);
    expect(isNoOutputGeneratedError("AI_NoOutputGeneratedError")).toBe(false);
    expect(isNoOutputGeneratedError(undefined)).toBe(false);
  });
});

describe("EmptyModelResponseError", () => {
  it("preserves the normalized SDK rejection as cause", () => {
    const sdkError = noOutputGeneratedError();
    const error = new EmptyModelResponseError({ cause: sdkError });
    expect(error.cause).toBe(sdkError);
    expect(error.message).toContain("did not return a response");
  });
});

describe("normalizeModelStreamError", () => {
  it("retains a plain provider payload for classification", () => {
    const raw = { message: "Overloaded", type: "overloaded_error" };
    const error = normalizeModelStreamError(raw);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Overloaded");
    expect(error.cause).toBe(raw);
    expect(classifyModelCallError(error)).toBe("retry");
  });

  it("returns Error instances unchanged", () => {
    const raw = new Error("stream failed");

    expect(normalizeModelStreamError(raw)).toBe(raw);
  });
});

/**
 * Classification is the only behavior this module owns. Error
 * rendering (details payload, OTel span exceptions) is covered in
 * `src/internal/logging.test.ts`.
 */
describe("classifyModelCallError", () => {
  it("returns recoverable for an empty model response, never retry", () => {
    // "retry" would re-run executeModelCall against step hooks whose
    // one-shot stepResult promise already resolved with the empty result.
    expect(classifyModelCallError(new EmptyModelResponseError())).toBe("recoverable");
  });

  it("returns terminal for a turn cancellation, even when marked retryable", () => {
    expect(classifyModelCallError(new TurnCancelledError())).toBe("terminal");

    const wrapped = Object.assign(new Error("socket hang up"), {
      cause: new TurnCancelledError(),
      isRetryable: true,
    });
    expect(classifyModelCallError(wrapped)).toBe("terminal");
  });

  it("returns retry when the AI SDK marks the error as retryable", () => {
    const err = Object.assign(new Error("upstream flaky"), { isRetryable: true });
    expect(classifyModelCallError(err)).toBe("retry");
  });

  it("returns retry for Anthropic overloaded stream payloads", () => {
    const overloaded = {
      message: "Overloaded",
      type: "overloaded_error",
    };

    expect(classifyModelCallError(overloaded)).toBe("retry");
    expect(classifyModelCallError(new Error("stream failed", { cause: overloaded }))).toBe("retry");
  });

  it("returns retry for HTTP statuses the AI SDK treats as retryable", () => {
    for (const statusCode of [408, 409, 429]) {
      const err = Object.assign(new Error("retryable"), { statusCode });
      expect(classifyModelCallError(err)).toBe("retry");
    }
  });

  it("returns retry for 5xx server errors", () => {
    for (const statusCode of [500, 502, 503, 504]) {
      const err = Object.assign(new Error("server down"), { statusCode });
      expect(classifyModelCallError(err)).toBe("retry");
    }
  });

  it("returns recoverable for ambiguous GatewayInternalServerError 400 responses", () => {
    const err = gatewayModelCallError({
      gatewayName: "GatewayInternalServerError",
      gatewayType: "internal_server_error",
      statusCode: 400,
      upstreamStatusCode: 400,
      upstreamType: "internal_server_error",
    });

    expect(classifyModelCallError(err)).toBe("recoverable");
  });

  it("returns terminal for explicit Gateway invalid-request errors", () => {
    const err = gatewayModelCallError({
      gatewayName: "GatewayInvalidRequestError",
      gatewayType: "invalid_request_error",
      statusCode: 400,
      upstreamStatusCode: 400,
      upstreamType: "invalid_request_error",
    });

    expect(classifyModelCallError(err)).toBe("terminal");
  });

  it("returns terminal for structural 4xx errors", () => {
    for (const statusCode of [400, 401, 403, 404, 413]) {
      const err = Object.assign(new Error("bad req"), { statusCode });
      expect(classifyModelCallError(err)).toBe("terminal");
    }
  });

  it("reads statusCode off the cause chain", () => {
    const inner = Object.assign(new Error("upstream"), { statusCode: 503 });
    const outer = new Error("gateway", { cause: inner });
    expect(classifyModelCallError(outer)).toBe("retry");
  });

  it("treats common network error messages as retry-worthy", () => {
    const econnreset = Object.assign(new Error("socket error"), {
      cause: new Error("ECONNRESET fired"),
    });
    expect(classifyModelCallError(econnreset)).toBe("retry");

    const fetchFailed = new Error("fetch failed");
    expect(classifyModelCallError(fetchFailed)).toBe("retry");
  });

  it("falls back to recoverable for unknown errors so the session parks instead of dying", () => {
    expect(classifyModelCallError(new Error("mystery"))).toBe("recoverable");
    expect(classifyModelCallError("weird string throw")).toBe("recoverable");
    expect(classifyModelCallError(null)).toBe("recoverable");
  });
});

describe("summarizeKnownModelCallConfigError", () => {
  it("tells the user to update or unset AI_GATEWAY_API_KEY when the gateway rejects the api key", () => {
    // This is the path users hit when a stale `AI_GATEWAY_API_KEY` in
    // their shell profile shadows the OIDC fallback.
    const summary = summarizeKnownModelCallConfigError(
      gatewayAuthError(
        "AI Gateway authentication failed: Invalid API key.\n\nCreate a new API key…",
      ),
    );
    expect(summary?.name).toBe("AI Gateway authentication failed");
    expect(summary?.message).toMatch(/AI_GATEWAY_API_KEY/);
    expect(summary?.message).toMatch(/unset/i);
  });

  it("tells the user to refresh the OIDC token when the gateway rejects it", () => {
    const summary = summarizeKnownModelCallConfigError(
      gatewayAuthError(
        "AI Gateway authentication failed: Invalid OIDC token.\n\nRun 'npx vercel link'…",
      ),
    );
    expect(summary?.name).toBe("AI Gateway authentication failed");
    expect(summary?.message).toMatch(/eve link/);
    expect(summary?.message).toMatch(/VERCEL_OIDC_TOKEN/);
  });

  it("tells the user to provide credentials when neither was offered", () => {
    const summary = summarizeKnownModelCallConfigError(
      gatewayAuthError(
        "AI Gateway authentication failed: No authentication provided.\n\nOption 1…",
      ),
    );
    expect(summary?.name).toBe("AI Gateway authentication failed");
    expect(summary?.message).toMatch(/eve link/);
    expect(summary?.message).toMatch(/AI_GATEWAY_API_KEY/);
  });

  it("returns null for unrelated errors so the harness uses the raw SDK message", () => {
    expect(summarizeKnownModelCallConfigError(new Error("something else broke"))).toBeNull();
    expect(summarizeKnownModelCallConfigError(null)).toBeNull();
  });
});

describe("summarizeKnownModelCallRequestError", () => {
  it("summarizes Gateway 400 model request failures without blaming tool input", () => {
    const summary = summarizeKnownModelCallRequestError(
      gatewayModelCallError({
        gatewayName: "GatewayInternalServerError",
        gatewayType: "internal_server_error",
        statusCode: 400,
        upstreamStatusCode: 400,
        upstreamType: "internal_server_error",
      }),
    );

    expect(summary).toEqual({
      name: "AI Gateway model request rejected",
      message: "AI Gateway rejected the model request before the agent produced a response.",
    });
  });

  it("uses nested OpenAI error.code messages when the top-level API message is generic", () => {
    const data = {
      error: {
        code: { message: "The requested model does not support this tool." },
        message: "AI_APICallError",
        type: "invalid_request_error",
      },
    };
    const summary = summarizeKnownModelCallRequestError(
      directApiCallError({
        data,
        responseBody: JSON.stringify(data),
        statusCode: 400,
      }),
    );

    expect(summary).toEqual({
      name: "Model provider API error",
      message: "The requested model does not support this tool.",
    });
  });

  it("uses the direct API error message when there is no response body", () => {
    const summary = summarizeKnownModelCallRequestError(
      directApiCallError({
        message: "No endpoints found for anthropic/claude-3.5-haiku",
        statusCode: 404,
      }),
    );

    expect(summary).toEqual({
      name: "Model provider API error",
      message: "No endpoints found for anthropic/claude-3.5-haiku",
    });
  });

  it("falls back to HTTP status and response body for direct generic API call errors", () => {
    const responseBody = JSON.stringify({
      error: {
        message: "AI_APICallError",
        type: "invalid_request_error",
      },
    });
    const summary = summarizeKnownModelCallRequestError(
      directApiCallError({
        responseBody,
        statusCode: 400,
      }),
    );

    expect(summary).toEqual({
      name: "Model provider API error",
      message: `Model provider API request failed (HTTP 400, invalid_request_error): ${responseBody}`,
    });
  });

  it("does not promote bare parameter names from the error body to the summary", () => {
    const data = {
      error: {
        message: "Bad Request",
        type: "invalid_request_error",
        param: "input",
      },
    };
    const summary = summarizeKnownModelCallRequestError(
      directApiCallError({
        data,
        responseBody: JSON.stringify(data),
        statusCode: 400,
      }),
    );

    expect(summary?.message).not.toBe("input");
    expect(summary?.message).toContain("Model provider API request failed (HTTP 400");
  });

  it("keeps the generic framing for transient upstream failures", () => {
    // A 503/429 that exhausts retries is an availability problem, not a
    // request rejection; summarizing it as "rejected" sends users to debug
    // their configuration.
    const summary = summarizeKnownModelCallRequestError(
      gatewayModelCallError({
        gatewayName: "GatewayInternalServerError",
        gatewayType: "overloaded_error",
        statusCode: 503,
        upstreamMessage: "Service temporarily unavailable",
        upstreamStatusCode: 503,
        upstreamType: "overloaded_error",
      }),
    );

    expect(summary).toBeNull();
  });
});

/**
 * Builds a realistic AI Gateway 400 error for a request that fanned out
 * across multiple providers — Anthropic primary 503, then fallbacks
 * rejecting the provider-specific `web_search_20250305` tool. The shape
 * mirrors what the gateway returns in `data.providerMetadata.gateway.routing`
 * and its `responseBody`.
 */
function gatewayProviderToolFailure(input: {
  readonly unsupportedTypes: readonly string[];
  readonly omitData?: boolean;
  readonly truncateResponseBody?: boolean;
}): Error {
  const providerAttempts = [
    {
      provider: "anthropic",
      credentialType: "system",
      success: false,
      error: "Service temporarily unavailable",
      statusCode: 503,
    },
    ...input.unsupportedTypes.map((type) => ({
      provider: "bedrock",
      credentialType: "system",
      success: false,
      error: `tool type '${type}' is not supported for this model`,
      statusCode: 400,
    })),
  ];

  const responseBodyValue = {
    error: {
      message: "Bad Request",
      type: "AI_APICallError",
      param: {
        error: "Bad Request",
        statusCode: 400,
        name: "AI_APICallError",
        message: "Bad Request",
        isRetryable: false,
        type: "AI_APICallError",
      },
    },
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "anthropic/claude-opus-4.7",
          resolvedProvider: "anthropic",
          fallbacksAvailable: ["bedrock", "vertexAnthropic"],
          canonicalSlug: "anthropic/claude-opus-4.7",
          modelAttemptCount: 1,
          modelAttempts: [
            {
              canonicalSlug: "anthropic/claude-opus-4.7",
              success: false,
              providerAttemptCount: providerAttempts.length,
              providerAttempts,
            },
          ],
        },
      },
    },
  };
  const fullResponseBody = JSON.stringify(responseBodyValue);
  const responseBody =
    input.truncateResponseBody === true
      ? // Truncate AFTER the upstream error phrase but before the JSON
        // is complete so `JSON.parse` fails and the raw-string fallback
        // is exercised.
        `${fullResponseBody.slice(0, fullResponseBody.indexOf("is not supported") + 30)}...<truncated>`
      : fullResponseBody;

  const upstream = Object.assign(new Error("[object Object]"), {
    data: input.omitData === true ? undefined : responseBodyValue,
    isRetryable: false,
    name: "AI_APICallError",
    responseBody,
    statusCode: 400,
  });
  return Object.assign(new Error("GatewayInternalServerError: Bad Request", { cause: upstream }), {
    generationId: "gen_recovery",
    isRetryable: false,
    name: "GatewayInternalServerError",
    statusCode: 400,
    type: "internal_server_error",
  });
}

describe("extractUnsupportedProviderToolTypes", () => {
  it("returns the upstream tool type from a Bedrock fallback rejection", () => {
    const error = gatewayProviderToolFailure({ unsupportedTypes: ["web_search_20250305"] });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual(["web_search_20250305"]);
  });

  it("deduplicates when multiple providerAttempts reference the same tool type", () => {
    const error = gatewayProviderToolFailure({
      unsupportedTypes: ["web_search_20250305", "web_search_20250305"],
    });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual(["web_search_20250305"]);
  });

  it("returns multiple types when distinct tools were rejected", () => {
    const error = gatewayProviderToolFailure({
      unsupportedTypes: ["web_search_20250305", "computer_20251022"],
    });

    expect([...extractUnsupportedProviderToolTypes(error)].sort()).toEqual([
      "computer_20251022",
      "web_search_20250305",
    ]);
  });

  it("recovers the tool type from a truncated responseBody via raw string scan", () => {
    // The `data` field is the structured projection. When `data` is
    // absent and the responseBody is truncated mid-JSON (as happens for
    // some gateway error shapes), we still want the upstream tool type
    // to be discoverable so recovery can run.
    const error = gatewayProviderToolFailure({
      unsupportedTypes: ["web_search_20250305"],
      omitData: true,
      truncateResponseBody: true,
    });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual(["web_search_20250305"]);
  });

  it("returns empty for the ambiguous internal server error case (no tool rejection)", () => {
    const innerBody = {
      error: { message: "Bad Request", type: "internal_server_error" },
      generationId: "gen_no_tool",
    };
    const upstream = Object.assign(new Error("[object Object]"), {
      data: innerBody,
      isRetryable: false,
      name: "AI_APICallError",
      responseBody: JSON.stringify(innerBody),
      statusCode: 400,
    });
    const error = Object.assign(new Error("gateway", { cause: upstream }), {
      isRetryable: false,
      name: "GatewayInternalServerError",
      statusCode: 400,
      type: "internal_server_error",
    });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual([]);
  });

  it("returns empty for generic structural 4xx errors", () => {
    const error = Object.assign(new Error("invalid api key"), {
      name: "AI_APICallError",
      statusCode: 401,
    });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual([]);
  });

  it("returns empty for non-tool 'not supported' phrasing", () => {
    // We anchor on the literal "tool type 'X' is not supported" phrasing
    // to avoid sweeping in unrelated rejection messages.
    const upstream = Object.assign(new Error("[object Object]"), {
      responseBody: '{"error":{"message":"streaming is not supported for this model"}}',
      statusCode: 400,
    });
    const error = Object.assign(new Error("gateway", { cause: upstream }), {
      name: "GatewayInternalServerError",
      statusCode: 400,
    });

    expect(extractUnsupportedProviderToolTypes(error)).toEqual([]);
  });

  it("returns empty for plain Error and null/undefined inputs", () => {
    expect(extractUnsupportedProviderToolTypes(new Error("mystery"))).toEqual([]);
    expect(extractUnsupportedProviderToolTypes(null)).toEqual([]);
    expect(extractUnsupportedProviderToolTypes(undefined)).toEqual([]);
  });
});

describe("extractModelCallErrorDetails", () => {
  it("lifts compact Gateway diagnostics out of a huge request body", () => {
    const details = extractModelCallErrorDetails(
      gatewayModelCallError({
        gatewayName: "GatewayInternalServerError",
        gatewayType: "internal_server_error",
        statusCode: 400,
        upstreamMessage: "Bad Request",
        upstreamStatusCode: 400,
        upstreamType: "internal_server_error",
      }),
    );

    expect(details).toMatchObject({
      gatewayName: "GatewayInternalServerError",
      gatewayType: "internal_server_error",
      generationId: "gen_test",
      responseBodySnippet: expect.stringContaining("internal_server_error"),
      statusCode: 400,
      upstreamMessage: "Bad Request",
      upstreamStatusCode: 400,
      upstreamType: "internal_server_error",
    });
    expect(JSON.stringify(details)).not.toContain("large schema");
  });

  it("keeps direct API response snippets when no parsed API message is useful", () => {
    const responseBody = JSON.stringify({
      error: { message: "AI_APICallError", type: "invalid_request_error" },
    });
    const details = extractModelCallErrorDetails(
      directApiCallError({
        responseBody,
        statusCode: 400,
      }),
    );

    expect(details).toMatchObject({
      responseBodySnippet: responseBody,
      statusCode: 400,
      upstreamMessage: "AI_APICallError",
      upstreamStatusCode: 400,
      upstreamType: "invalid_request_error",
    });
  });
});
