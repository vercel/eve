import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientError } from "#client/client-error.js";
import { openStreamBody } from "#client/open-stream.js";

const STREAM_INPUT = {
  host: "https://example.com",
  resolveHeaders: async () => new Headers(),
  sessionId: "session_1",
  startIndex: 0,
} as const;

function createNdjsonBody(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

describe("openStreamBody", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 425 readiness failures before succeeding", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({
            code: "session_not_ready",
            error: "Session projection is still catching up.",
            ok: false,
          }),
          {
            headers: { "cache-control": "no-store" },
            status: 425,
          },
        );
      }

      return new Response(createNdjsonBody([{ type: "session.waiting", data: {} }]), {
        status: 200,
      });
    });

    const bodyPromise = openStreamBody(STREAM_INPUT);
    await vi.advanceTimersByTimeAsync(250);
    const body = await bodyPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toBeInstanceOf(ReadableStream);
  });

  it("does not retry non-retryable auth failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "forbidden",
          error: "Not allowed.",
          ok: false,
        }),
        { status: 403 },
      ),
    );

    await expect(openStreamBody(STREAM_INPUT)).rejects.toBeInstanceOf(ClientError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops retrying when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      return new Response(
        JSON.stringify({
          code: "session_not_ready",
          error: "Session projection is still catching up.",
          ok: false,
        }),
        { status: 425 },
      );
    });

    await expect(
      openStreamBody({
        ...STREAM_INPUT,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
