import { expect, it } from "vitest";

import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { defineHook } from "#public/definitions/hook.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

async function createPublishingRuntime() {
  const hooked: { event: MessageStreamEvent; sessionId: string }[] = [];
  const runtime = await createTestRuntime({
    agent: { name: "publish-session-events" },
    modules: [
      {
        logicalPath: "hooks/audit.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              async "action.partial"(event, ctx) {
                hooked.push({ event, sessionId: ctx.session.id });
              },
              async "input.resolved"(event, ctx) {
                hooked.push({ event, sessionId: ctx.session.id });
              },
            },
          }),
        }),
      },
    ],
  });
  const streamed: MessageStreamEvent[] = [];
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      streamed.push(JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
    },
  });
  return { hooked, runtime, sessionWritable, streamed };
}

it("publishes a session step's action.partial to the stream and its hooks", async () => {
  const { hooked, runtime, sessionWritable, streamed } = await createPublishingRuntime();

  await runtime.run(async () => {
    await emitWorkflowToolRunReportStep({
      from: {
        callId: "call-1",
        input: {},
        runId: "run-1",
        sequence: 1,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      serializedContext,
      sessionState: createTestSessionState(),
      sessionWritable,
      update: { progress: "halfway" },
    });
  });

  expect(streamed).toEqual([
    expect.objectContaining({
      type: "action.partial",
      data: expect.objectContaining({ turnId: "turn-1" }),
    }),
  ]);
  expect(hooked).toEqual([{ event: streamed[0], sessionId: "test-session" }]);
});
