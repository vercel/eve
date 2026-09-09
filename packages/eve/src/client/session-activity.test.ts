import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import {
  EVE_ACTIVITY_STREAM_FORMAT,
  EVE_ACTIVITY_STREAM_VERSION,
  type ActivitySnapshotV1,
} from "#protocol/activity.js";
import {
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const snapshot: ActivitySnapshotV1 = {
  actions: {},
  blockers: {},
  pendingSettlements: {},
  revision: 1,
  seenEventIds: [],
  version: 1,
  work: {},
};

function response(snapshots: readonly unknown[], tailIndex = snapshots.length - 1) {
  return new Response(snapshots.map((value) => `${JSON.stringify(value)}\n`).join(""), {
    headers: activityHeaders(tailIndex),
  });
}

function activityHeaders(tailIndex?: number) {
  const headers = new Headers({
    [EVE_STREAM_FORMAT_HEADER]: EVE_ACTIVITY_STREAM_FORMAT,
    [EVE_STREAM_VERSION_HEADER]: EVE_ACTIVITY_STREAM_VERSION,
  });
  if (tailIndex !== undefined) {
    headers.set(EVE_STREAM_TAIL_INDEX_HEADER, String(tailIndex));
  }
  return headers;
}

function session() {
  return new ClientSession(
    {
      host: "https://eve.test",
      resolveHeaders: async () => new Headers({ authorization: "Bearer token" }),
    },
    { sessionId: "session_1", streamIndex: 4 },
  );
}

describe("ClientSession.activity", () => {
  it("reads the latest snapshot without changing either cursor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response([snapshot]));
    const attached = session();

    await expect(attached.activity.snapshot()).resolves.toEqual({
      snapshot,
      session: { sessionId: "session_1", streamIndex: 1 },
    });

    expect(attached.state.streamIndex).toBe(4);
    expect(attached.activity.streamIndex).toBe(0);
    const request = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(request.pathname).toBe("/eve/v1/session/session_1/activity/stream");
    expect(request.searchParams.get("includeTailIndex")).toBe("1");
  });

  it("rejects malformed nested snapshot state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([{ ...snapshot, actions: { action: { id: "action", phase: "running" } } }]),
    );
    const attached = session();

    await expect(attached.activity.snapshot()).rejects.toThrow(
      "Activity stream returned an invalid snapshot.",
    );
  });

  it("reconnects an activity stream after the shared idle timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>(), { headers: activityHeaders() }),
      )
      .mockResolvedValueOnce(response([snapshot]));
    const attached = session();
    const iterator = attached.activity
      .stream({
        streamReconnectPolicy: {
          streamIdleReconnectPolicy: { baseDelayMs: 250, maxAttempts: 1, maxDelayMs: 250 },
        },
      })
      [Symbol.asyncIterator]();

    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(15_250);

    await expect(next).resolves.toEqual({ done: false, value: snapshot });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await iterator.return?.();
  });

  it("advances an activity-only cursor when streaming", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([snapshot]));
    const attached = session();

    const revisions: number[] = [];
    for await (const update of attached.activity.stream({
      follow: false,
      streamReconnectPolicy: { reconnect: false },
    })) {
      revisions.push(update.revision);
    }

    expect(revisions).toEqual([1]);
    expect(attached.activity.streamIndex).toBe(1);
    expect(attached.state.streamIndex).toBe(4);
  });
});
