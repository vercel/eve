import { describe, expect, it } from "vitest";

import {
  readSessionRecordHistory,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import {
  registerSessionLineStore,
  sessionLineStore,
  workflowLineStore,
  type SessionLineStore,
} from "#execution/session-line-store.js";

/** A store holding fixed lines for every session it's registered for. */
function fixedStore(records: readonly unknown[]): SessionLineStore {
  const encoder = new TextEncoder();
  return {
    assertReadable: async () => {},
    readable: (_sessionId, startIndex = 0) =>
      new ReadableStream({
        start(controller) {
          for (const record of records.slice(startIndex))
            controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
          controller.close();
        },
      }),
    tail: async () => records.length - 1,
  };
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const records: unknown[] = [];
  for await (const record of stream) records.push(record);
  return records;
}

describe("session line stores", () => {
  it("reads a registered session from its store, and Workflow's run once unregistered", async () => {
    const store = fixedStore([{ line: "Alice" }, { line: "Bob" }]);
    const unregister = registerSessionLineStore("session-alice", store);
    try {
      expect(sessionLineStore("session-alice")).toBe(store);
      expect(sessionLineStore("session-bob")).toBe(workflowLineStore);
      await expect(readSessionStreamTailIndex("session-alice")).resolves.toBe(1);
      await expect(readAll(readSessionRecordHistory("session-alice", -1))).resolves.toEqual([
        { line: "Bob" },
      ]);
    } finally {
      unregister();
    }
    expect(sessionLineStore("session-alice")).toBe(workflowLineStore);
  });

  it("refuses a second store for the same session", () => {
    const unregister = registerSessionLineStore("session-alice", fixedStore([]));
    try {
      expect(() => registerSessionLineStore("session-alice", fixedStore([]))).toThrow(
        'Session "session-alice" already has a line store.',
      );
    } finally {
      unregister();
    }
  });
});
