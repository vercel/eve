import { describe, expect, it } from "vitest";

import { opaque } from "#execution/durable.js";
import {
  keepSessionRecord,
  openSessionRecord,
  restoreSessionRecord,
  sealSessionRecord,
  SESSION_LIMITS,
  SESSION_RECORD_VERSION,
  SessionRecordTooNew,
  type SessionRecord,
} from "#execution/session/record.js";
import { createMemoryContentStore } from "#internal/testing/session-host/memory-content-store.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

const transfer = {
  admittedDeliveryKeys: ["alice-1"],
  history: [],
  serializedContext: {},
  sessionState: createTestSessionState({ sessionId: "session-1" }),
};

describe("the session record", () => {
  it("opens a record this eve sealed", () => {
    const record = sealSessionRecord({ generation: 3, open: { at: "step" }, transfer });

    expect(openSessionRecord(record)).toEqual({
      generation: 3,
      open: { at: "step" },
      transfer,
      version: SESSION_RECORD_VERSION,
    });
  });

  it("refuses a record a newer eve wrote", () => {
    const newer: SessionRecord = opaque({
      generation: 1,
      open: undefined,
      transfer,
      version: SESSION_RECORD_VERSION + 1,
    });

    expect(() => openSessionRecord(newer)).toThrow(SessionRecordTooNew);
  });

  it("refuses a record over the size limit", () => {
    const note = "Alice's notes. ".repeat(SESSION_LIMITS.recordBytes / 10);

    expect(() =>
      sealSessionRecord({
        generation: 1,
        open: undefined,
        transfer: { ...transfer, serializedContext: { note } },
      }),
    ).toThrow(`over the ${SESSION_LIMITS.recordBytes}-byte limit`);
  });

  it("keeps a large transfer in the content store, and restores the same record", async () => {
    const content = createMemoryContentStore();
    const out = { content, sessionId: "session-1" };
    const note = "Alice's notes. ".repeat(SESSION_LIMITS.recordBytes / 10);
    const contents = {
      generation: 2,
      open: undefined,
      transfer: { ...transfer, serializedContext: { note } },
    };

    const record = await keepSessionRecord(contents, out);

    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThan(
      SESSION_LIMITS.recordBytes,
    );
    expect(content.size("session-1")).toBeGreaterThan(0);
    expect(await restoreSessionRecord(record, out)).toEqual({
      ...contents,
      version: SESSION_RECORD_VERSION,
    });
    await expect(keepSessionRecord(contents)).rejects.toThrow(
      `over the ${SESSION_LIMITS.recordBytes}-byte limit`,
    );
  });
});
