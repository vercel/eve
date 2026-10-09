import { expect, it, vi } from "vitest";

import { readTurnState } from "#harness/session-machine/state.js";

import { sandboxProvider } from "#context/providers/sandbox.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { commitSessionStep } from "#execution/session/commit-step.js";
import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { withdrawWorkflowToolRunQuestionStep } from "#execution/tools/workflow/withdraw-step.js";

import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createInputRequestedEvent, type MessageStreamEvent } from "#protocol/message.js";
import { withPublished, withRelays } from "#internal/testing/session-machine.js";
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
  const asked = withRelays(
    withPublished(base.snapshot.session as HarnessSession, [
      createInputRequestedEvent({
        callId: "call-1",
        requests: [
          {
            action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "research" },
            kind: "question",
            prompt: "Which region should Alice's report cover?",
            requestId: "ask-1",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    ]),
    {
      entries: [
        [
          "ask-1",
          {
            workflowAsk: { control: "control" },
            reply: {},
            runId: "run-1",
            childContinuationToken: "ask-1",
            event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "ask-1",
    },
  );

  await runtime.run(async () => {
    await withdrawWorkflowToolRunQuestionStep({
      control: "control",
      requestId: "ask-1",
      runId: "run-1",
      serializedContext,
      sessionState: replaceDurableSessionSnapshot({ session: asked, state: base }),
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

it("keeps what the sandbox provider commits when a session step saves a transition", async () => {
  const { runtime, sessionWritable } = await createPublishingRuntime();
  const captured = { session: null, snapshot: "captured-in-scope" };
  const commit = vi
    .spyOn(sandboxProvider, "commit")
    .mockImplementation(async (_access, session) => ({ ...session, sandboxState: captured }));
  try {
    const published = await runtime.run(() =>
      commitSessionStep(
        { serializedContext, sessionState: createTestSessionState(), sessionWritable },
        (view) => [{ events: [], turn: { ...view.turn, grants: ["deploy"] } }],
        { origin: "relayed" },
      ),
    );
    expect(commit).toHaveBeenCalled();
    expect(published.sessionState.snapshot.session.sandboxState).toEqual(captured);
    expect(readTurnState(readDurableSession(published.sessionState).state).grants).toEqual([
      "deploy",
    ]);
  } finally {
    commit.mockRestore();
  }
});
