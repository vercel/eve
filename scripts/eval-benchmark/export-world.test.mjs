import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWorkflowEvent } from "./export-world.mjs";

test("keeps each workflow event's identity and payload sizes, never its payloads", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const summary = summarizeWorkflowEvent({
    eventId: "evnt_1",
    eventType: "step_completed",
    correlationId: "step_1",
    createdAt,
    eventData: {
      stepName: "step//eve//turnStep",
      result: new Uint8Array(1234),
      // Older worlds stored JSON payloads.
      error: { message: "Alice's tool failed" },
    },
  });
  assert.deepEqual(summary, {
    eventType: "step_completed",
    correlationId: "step_1",
    createdAt,
    payloadBytes: {
      result: 1234,
      error: Buffer.byteLength(JSON.stringify({ message: "Alice's tool failed" })),
    },
    stepName: "step//eve//turnStep",
  });
  // A purged payload is absent, so the publish job can tell it from an empty one.
  assert.deepEqual(
    summarizeWorkflowEvent({ eventType: "step_created", eventData: {} }).payloadBytes,
    {},
  );
});
