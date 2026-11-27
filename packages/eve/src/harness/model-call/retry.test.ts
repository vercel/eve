import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { SessionStreamWriteError } from "#harness/session-stream-write-error.js";

import { ALLOW_RETRY, runModelCallWithRetries, STOP_RETRY } from "./retry.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const session = { sessionId: "session-alice", turnId: "turn-1" };
const busy = () => Object.assign(new Error("The provider is busy."), { isRetryable: true });

describe("runModelCallWithRetries", () => {
  it("doesn't retry a dead session stream, even when its cause reads as transient", async () => {
    const dead = new SessionStreamWriteError(busy());
    const call = vi.fn(async () => {
      throw new Error("The model call failed.", { cause: dead });
    });
    const onRetry = vi.fn(async () => {});

    await expect(runModelCallWithRetries(call, { ...session, onRetry })).rejects.toBe(dead);
    expect(call).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("doesn't retry a failure eve's policies stop, whatever another policy allows", async () => {
    const call = vi.fn(async () => {
      throw new Error("The request is malformed.");
    });

    await expect(
      runModelCallWithRetries(call, { ...session, policies: [() => ALLOW_RETRY] }),
    ).rejects.toThrow("malformed");
    expect(call).toHaveBeenCalledOnce();
  });

  it("stops retrying a transient failure when a policy stops it", async () => {
    const call = vi.fn(async () => {
      throw busy();
    });
    const onRetry = vi.fn(async () => {});

    await expect(
      runModelCallWithRetries(call, { ...session, onRetry, policies: [() => STOP_RETRY] }),
    ).rejects.toThrow("busy");
    expect(call).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a gateway stream timeout only once", async () => {
    const call = vi.fn(async () => {
      throw new Error("Stream exceeded maximum duration before function timeout", {
        cause: { code: "gateway_stream_timeout", origin: "gateway" },
      });
    });

    await expect(runModelCallWithRetries(call, session)).rejects.toThrow("maximum duration");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("retries an AI Gateway fallback rejection while the primary provider is unavailable, within the same budget", async () => {
    const providerAttempts = [
      { error: "Service temporarily unavailable", provider: "anthropic", statusCode: 503 },
      {
        error: "Invalid encrypted_content in search_result block",
        provider: "vertexAnthropic",
        statusCode: 400,
      },
    ];
    const call = vi.fn(async () => {
      throw Object.assign(
        new Error("Bad Request", {
          cause: Object.assign(new Error("Bad Request"), {
            data: {
              providerMetadata: { gateway: { routing: { modelAttempts: [{ providerAttempts }] } } },
            },
            name: "AI_APICallError",
            statusCode: 400,
          }),
        }),
        { name: "GatewayInternalServerError", statusCode: 400, type: "internal_server_error" },
      );
    });

    await expect(runModelCallWithRetries(call, session)).rejects.toThrow("Bad Request");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("keeps the full retry budget for other transient failures", async () => {
    const call = vi.fn(async () => {
      throw busy();
    });

    await expect(runModelCallWithRetries(call, session)).rejects.toThrow("busy");
    expect(call).toHaveBeenCalledTimes(5);
  });

  it("honors Retry-After headers on rate-limited responses", async () => {
    vi.mocked(delay).mockClear();
    let attempts = 0;
    const call = vi.fn(async () => {
      if ((attempts += 1) === 1) {
        throw Object.assign(new Error("Too Many Requests"), {
          isRetryable: true,
          responseHeaders: { "retry-after": "7" },
          statusCode: 429,
        });
      }
      return "ok";
    });

    await expect(runModelCallWithRetries(call, session)).resolves.toBe("ok");
    expect(vi.mocked(delay)).toHaveBeenCalledWith(7_000, undefined, { signal: undefined });
  });
});
