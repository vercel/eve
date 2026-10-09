import type { SessionStreamEvent } from "#protocol/session-event.js";
import { expect, it } from "vitest";

import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createSessionFailedEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "session_xyz",
  "eve.turnDeliveryIds": ["delivery_restored"],
};

function failedEvent() {
  return createSessionFailedEvent({
    code: "WORKFLOW_EXECUTION_FAILED",
    message: "failed",
    sessionId: "session_xyz",
    usage: undefined,
  });
}

/** A session writable that records writes and the close, in order. */
function recordingWritable() {
  const ops: Array<{ kind: "write"; event: SessionStreamEvent } | { kind: "close" }> = [];
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      ops.push({
        kind: "write",
        event: JSON.parse(new TextDecoder().decode(chunk)) as SessionStreamEvent,
      });
    },
    close() {
      ops.push({ kind: "close" });
    },
  });
  return { ops, sessionWritable };
}

it("closes the durable stream after publishing a terminal session.failed", async () => {
  const runtime = await createTestRuntime({ agent: { name: "terminal-session-stream" } });
  const { ops, sessionWritable } = recordingWritable();

  await runtime.run(async () => {
    await publishTerminalSessionEvent({ event: failedEvent(), sessionWritable, serializedContext });
  });

  expect(ops.map((op) => op.kind)).toEqual(["write", "close"]);
  const [written] = ops;
  if (written?.kind !== "write") throw new Error("Expected the terminal event to be written.");
  expect(written.event.type).toBe("session.failed");
  // Only the restored-context publisher stamps the turn's delivery ids; the
  // degraded fallback writes without them, so this pins the restored path.
  expect(written.event.meta.deliveryIds).toEqual(["delivery_restored"]);
});

it("writes the terminal event, then closes, when the context cannot be restored", async () => {
  const { ops, sessionWritable } = recordingWritable();

  await publishTerminalSessionEvent({
    event: failedEvent(),
    sessionWritable,
    serializedContext: {
      "eve.sessionId": "session_xyz",
      "eve.turnDeliveryIds": ["delivery_restored"],
    },
  });

  expect(ops.map((op) => op.kind)).toEqual(["write", "close"]);
  const [written] = ops;
  if (written?.kind !== "write") throw new Error("Expected the terminal event to be written.");
  expect(written.event).toMatchObject({
    type: "session.failed",
    data: { code: "WORKFLOW_EXECUTION_FAILED", sessionId: "session_xyz" },
  });
  expect(written.event.meta.deliveryIds).toBeUndefined();
});
