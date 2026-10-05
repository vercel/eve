import { expect, it } from "vitest";

import { publishTerminalSessionEvent } from "#execution/publish-session-events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createSessionFailedEvent, type MessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "session_xyz",
};

it("closes the durable stream after publishing a terminal session.failed", async () => {
  const runtime = await createTestRuntime({ agent: { name: "terminal-session-stream" } });
  const streamed: MessageStreamEvent[] = [];
  let closed = false;
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      streamed.push(JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
    },
    close() {
      closed = true;
    },
  });

  await runtime.run(async () => {
    await publishTerminalSessionEvent({
      event: createSessionFailedEvent({
        code: "WORKFLOW_EXECUTION_FAILED",
        message: "failed",
        sessionId: "session_xyz",
      }),
      sessionWritable,
      serializedContext,
    });
  });

  expect(streamed.map((event) => event.type)).toEqual(["session.failed"]);
  expect(closed).toBe(true);
});

it("closes the durable stream when the terminal event is written without a context", async () => {
  let closed = false;
  const sessionWritable = new WritableStream<Uint8Array>({
    close() {
      closed = true;
    },
  });

  await publishTerminalSessionEvent({
    event: createSessionFailedEvent({
      code: "WORKFLOW_EXECUTION_FAILED",
      message: "failed",
      sessionId: "session_xyz",
    }),
    sessionWritable,
    serializedContext: { "eve.sessionId": "session_xyz" },
  });

  expect(closed).toBe(true);
});
