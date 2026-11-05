import { describe, expect, it } from "vitest";

import { SESSION_CHECKPOINT_VERSION } from "#execution/session/checkpoint.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

import { planRestore } from "./restore.js";
import type { AcceptedInput } from "./session-store.js";
import { SESSION_SNAPSHOT_FORMAT, type SessionSnapshot } from "./snapshot.js";

const send = (seq: number, deliveryId: string): AcceptedInput => ({
  command: {
    delivery: { channelKind: "http", channelName: "http", deliveryId },
    kind: "send",
    payload: { message: `message ${String(seq)}` },
  },
  seq,
  token: "eve:session:session_a:inbox",
});

function snapshotWith(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    checkpoint: {
      admittedDeliveryKeys: [],
      history: [],
      serializedContext: { "eve.sessionId": "session_a" },
      sessionState: createTestSessionState({ sessionId: "session_a" }),
      sessionTimeoutMs: false,
      version: SESSION_CHECKPOINT_VERSION,
    },
    format: SESSION_SNAPSHOT_FORMAT,
    lines: [],
    sessionId: "session_a",
    takenAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("planning a restore", () => {
  it("waits as the session was between turns, and reruns nothing the checkpoint covers", () => {
    const plan = planRestore(snapshotWith());
    expect(plan.boot.start).toBeUndefined();
    expect(plan.boot.rerunFirst).toBe(false);
    expect(plan.boot.serializedContext).toMatchObject({ "eve.sessionId": "session_a" });
    expect(plan.deadline).toBeUndefined();
  });

  it("resumes an open turn, reruns its step when the stream passed the checkpoint, and keeps the deadline", () => {
    const plan = planRestore(
      snapshotWith({
        deadline: "2026-11-05T00:00:00.000Z",
        lines: ['{"line":1}'],
        open: { at: "step" },
      }),
    );
    expect(plan.boot.start).toEqual({ from: { at: "step" }, kind: "resume" });
    expect(plan.boot.rerunFirst).toBe(true);
    expect(plan.deadline).toEqual(new Date("2026-11-05T00:00:00.000Z"));
  });

  it("redelivers what no saved step read, but not what the step it goes on with reads itself", () => {
    const plan = planRestore(
      snapshotWith({
        inputs: { next: 2, unread: [send(0, "delivery-0"), send(1, "delivery-1")] },
        open: {
          at: "step",
          input: {
            delivery: {
              deliveryMetadata: [
                {
                  channelKind: "http",
                  channelName: "http",
                  deliveryId: "delivery-0",
                  payloadIndex: 0,
                },
              ],
              kind: "deliver",
              payloads: [],
            },
          },
        },
      }),
    );
    expect(plan.redeliver.map(({ seq }) => seq)).toEqual([1]);
  });

  it("refuses a snapshot in another format before reading anything else", () => {
    const earlier = JSON.parse(
      JSON.stringify({ ...snapshotWith(), checkpoint: {}, format: "eve.in-process-session/1" }),
    );
    expect(() => planRestore(earlier)).toThrow(
      `Session "session_a" can't be restored here: its snapshot is in format "eve.in-process-session/1", and this build reads "${SESSION_SNAPSHOT_FORMAT}".`,
    );
  });

  it("refuses a checkpoint this build can't continue, with why", () => {
    expect(() => planRestore(snapshotWith({ checkpoint: JSON.parse('{"version":1}') }))).toThrow(
      `Session "session_a" can't be restored here:`,
    );
  });
});
