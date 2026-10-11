import { afterEach, describe, expect, it, vi } from "vitest";

import { followStreamIterable, openStreamBody } from "./open-stream.js";
import { ClientSessionStrandedError } from "#client/client-error.js";
import type { StreamReconnectPolicy } from "#client/types.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_CONTROL_VERSION,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_LEASE_ENDED_CONTROL,
  EVE_STREAM_TAIL_INDEX_HEADER,
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
      path: "/eve/v1/session/session_1/stream",
      startIndex: 0,
    });
    connection.close();
    connection.close();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });

  it("stops reconnecting when a stranded stream returns an actionable conflict", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          code: "session_stranded",
          eveVersion: "0.0.1",
          error: "Reset this session to continue.",
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stream = followStreamIterable({
      host: "https://agent.example",
      path: "/eve/v1/session/session_1/stream",
      resolveHeaders: async () => new Headers(),
      startIndex: 0,
      keepAlive: true,
    });
    await expect(stream.next()).rejects.toThrow(ClientSessionStrandedError);
    expect(fetchMock).toHaveBeenCalledOnce();
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
      path: "/eve/v1/session/session_1/stream",
      startIndex: 0,
    });
    connection.close();

    expect(requestUrl?.searchParams.get(EVE_STREAM_CONTROL_VERSION_QUERY)).toBe(
      EVE_STREAM_CONTROL_VERSION,
    );
  });

  it.each(["Load failed", "NetworkError when attempting to fetch resource."])(
    "retries a browser network error while opening a stream: %s",
    async (message) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError(message))
        .mockResolvedValue(
          new Response("", {
            headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
            status: 200,
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const connection = await openStreamBody({
        host: "https://agent.example",
        resolveHeaders: () => Promise.resolve(new Headers()),
        path: "/eve/v1/session/session_1/stream",
        startIndex: 0,
        streamReconnectPolicy: { streamOpenReconnectPolicy: { baseDelayMs: 1, maxAttempts: 2 } },
      });
      connection.close();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe("followStreamIterable", () => {
  it("finishes a live follow when reset publishes a terminal event", async () => {
    const event = {
      type: "session.failed",
      data: { code: "session_stranded", message: "Start a new session.", sessionId: "session_1" },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(event) + "\n", {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stream = followStreamIterable({
      host: "https://agent.example",
      path: "/eve/v1/session/session_1/stream",
      resolveHeaders: async () => new Headers(),
      startIndex: 0,
      keepAlive: true,
    });
    await expect(stream.next()).resolves.toMatchObject({ done: false, value: event });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors explicit idle retry limits even while following continuously", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("\n", {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for await (const event of followStreamIterable({
      host: "https://agent.example",
      resolveHeaders: () => Promise.resolve(new Headers()),
      keepAlive: true,
      resolveReconnectPolicy: () => ({
        streamIdleReconnectPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      }),
      path: "/eve/v1/session/session_1/stream",
      startIndex: 0,
    })) {
      expect.unreachable(`Unexpected event: ${event.type}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { startIndex: -1, streamReconnectPolicy: undefined },
    { startIndex: 0, streamReconnectPolicy: { reconnect: false } },
    {
      startIndex: 0,
      streamReconnectPolicy: { streamIdleReconnectPolicy: { maxAttempts: 0 } },
    },
  ] satisfies Array<{
    startIndex: number;
    streamReconnectPolicy: StreamReconnectPolicy | undefined;
  }>)("does not request a lease when it cannot renew: %j", async (options) => {
    const requestUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        requestUrls.push(new URL(String(input)));
        return new Response("\n", {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        });
      }),
    );

    for await (const event of followStreamIterable({
      host: "https://agent.example",
      resolveHeaders: () => Promise.resolve(new Headers()),
      path: "/eve/v1/session/session_1/stream",
      ...options,
    })) {
      expect.unreachable(`Unexpected event: ${event.type}`);
    }

    expect(requestUrls).toHaveLength(1);
    expect(requestUrls[0]?.searchParams.has(EVE_STREAM_CONTROL_VERSION_QUERY)).toBe(false);
  });

  it.each([true, false])(
    "resumes from the event cursor across leases without gaps or duplicates (follow: %s)",
    async (follow) => {
      const events = Array.from({ length: 7 }, (_, index) => ({
        type: "message.appended",
        data: {
          messageDelta: String(index),
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: { id: `evt_${index}`, at: "2026-09-15T00:00:00.000Z" },
      }));
      const cursors: number[] = [];
      const tailRequests: Array<string | null> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          expect(url.searchParams.get(EVE_STREAM_CONTROL_VERSION_QUERY)).toBe(
            EVE_STREAM_CONTROL_VERSION,
          );
          const cursor = Number(url.searchParams.get("startIndex") ?? "0");
          cursors.push(cursor);
          tailRequests.push(url.searchParams.get("includeTailIndex"));
          expect(cursors.length).toBeLessThanOrEqual(3);
          const records = events.slice(cursor, cursor + 2).map((event) => JSON.stringify(event));
          return new Response(
            `\n${records.join("\n\n")}\n\n${JSON.stringify(EVE_STREAM_LEASE_ENDED_CONTROL)}\n`,
            {
              headers: {
                [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
                ...(url.searchParams.has("includeTailIndex")
                  ? { [EVE_STREAM_TAIL_INDEX_HEADER]: String(events.length - 1) }
                  : {}),
              },
            },
          );
        }),
      );

      const received = [];
      for await (const event of followStreamIterable({
        host: "https://agent.example",
        resolveHeaders: () => Promise.resolve(new Headers()),
        path: "/eve/v1/session/session_1/stream",
        startIndex: 1,
        follow,
      })) {
        received.push(event);
        if (follow && received.length === events.length - 1) break;
      }

      expect(received).toEqual(events.slice(1));
      expect(cursors).toEqual([1, 3, 5]);
      expect(tailRequests).toEqual(follow ? [null, null, null] : ["1", null, null]);
    },
  );

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
      path: "/eve/v1/session/session_1/stream",
      signal: abort.signal,
      startIndex: 0,
    })) {
      // No durable events are expected.
    }

    expect(connections).toBe(8);
  });
});
