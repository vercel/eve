import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

import { openStreamBody } from "./open-stream.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openStreamBody", () => {
  it("cancels an opened response body and aborts its request exactly once when closed", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      signal = init?.signal ?? undefined;
      return new Response(body, {
        headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
      });
    });

    const connection = await openStreamBody({
      host: "https://eve.test",
      resolveHeaders: async () => new Headers(),
      sessionId: "session_1",
      startIndex: 0,
    });
    connection.close();
    connection.close();
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
