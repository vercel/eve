import { afterEach, describe, expect, it, vi } from "vitest";

import { followStreamIterable, openStreamBody } from "./open-stream.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_CONTROL_VERSION,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_LEASE_ENDED_CONTROL,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("advertises support for versioned stream controls", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        requestUrl = new URL(String(input));
        return new Response("\n", {
          headers: {
            [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          },
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

    expect(requestUrl?.searchParams.get(EVE_STREAM_CONTROL_VERSION_QUERY)).toBe(
      EVE_STREAM_CONTROL_VERSION,
    );
  });
});

describe("followStreamIterable", () => {
  it("renews an explicitly ended lease without charging the idle budget", async () => {
    let connections = 0;
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        connections += 1;
        if (connections === 8) abort.abort();
        return new Response(`${JSON.stringify(EVE_STREAM_LEASE_ENDED_CONTROL)}\n`, {
          headers: {
            [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          },
          status: 200,
        });
      }),
    );

    for await (const _event of followStreamIterable({
      host: "https://agent.example",
      resolveHeaders: () => Promise.resolve(new Headers()),
      sessionId: "session_1",
      signal: abort.signal,
      startIndex: 0,
    })) {
      // No durable events are expected.
    }

    expect(connections).toBe(8);
  });
});
