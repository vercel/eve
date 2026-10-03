import { expect, it } from "vitest";

import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { withdrawRelayedRequestsStep } from "#harness/human-input/effects/steps.js";
import { HumanInput } from "#harness/human-input/index.js";
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

it("relays a withdrawn workflow question's input.resolved to the stream and its hooks", async () => {
  const { hooked, runtime, sessionWritable, streamed } = await createPublishingRuntime();
  const base = createTestSessionState();
  const state = HumanInput.read(base.snapshot.session.state)
    .interrupt({
      at: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
      requests: [
        {
          action: { callId: "ask-1", input: {}, kind: "tool-call", toolName: "ask" },
          kind: "question",
          prompt: "Which region?",
          requestId: "ask-1",
        },
      ],
      route: { childContinuationToken: "ask-1", control: "control", runId: "run-1" },
      type: "relayed.requested",
    })
    .humanInput.write(base.snapshot.session.state);

  await runtime.run(async () => {
    await withdrawRelayedRequestsStep({
      intake: {
        control: "control",
        requestId: "ask-1",
        runId: "run-1",
        type: "withdraw.requested",
      },
      serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: { ...base.snapshot.session, state },
        state: base,
      }),
      sessionWritable,
    });
  });

  expect(streamed).toEqual([
    expect.objectContaining({
      type: "input.resolved",
      data: expect.objectContaining({
        resolutions: [{ kind: "question", outcome: "cancelled", requestId: "ask-1" }],
        turnId: "turn-1",
      }),
    }),
  ]);
  expect(hooked).toEqual([{ event: streamed[0], sessionId: "test-session" }]);
});
