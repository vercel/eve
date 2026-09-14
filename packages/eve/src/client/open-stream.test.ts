import { afterEach, describe, expect, it, vi } from "vitest";

import { openStreamBody } from "./open-stream.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openStreamBody", () => {
  it("cancels an opened response body when the stream follower closes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(body, {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
          status: 200,
        });
      }),
    );

    const connection = await openStreamBody({
      host: "https://agent.example",
      resolveHeaders: () => Promise.resolve(new Headers()),
      sessionId: "session_1",
      startIndex: 0,
    });
    connection.close();
    connection.close();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });
});
