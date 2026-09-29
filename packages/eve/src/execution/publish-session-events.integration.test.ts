import { expect, it } from "vitest";

import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import {
  emitWorkflowToolRunReportStep,
  writeEarlyRunMessageEventStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { withdrawWorkflowToolRunQuestionStep } from "#execution/tools/workflow/withdraw-step.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineState } from "#public/definitions/state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

const openedSessions = defineState("test.opened-sessions", (): string[] => []);

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
              async "agent.started"(event, ctx) {
                hooked.push({ event, sessionId: ctx.session.id });
                openedSessions.update((opened) => [...opened, event.data.sessionId]);
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
      pendingDispatches: [],
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
  const asked = upsertProxyInputRequests({
    entries: [
      [
        "ask-1",
        {
          workflowAsk: { control: "control", question: {}, runId: "run-1" },
          childContinuationToken: "ask-1",
          event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
          kind: "question",
        },
      ],
    ],
    forChildContinuationToken: "ask-1",
    session: base.snapshot.session as HarnessSession,
  });

  await runtime.run(async () => {
    await withdrawWorkflowToolRunQuestionStep({
      pendingDispatches: [],
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

it("dispatches an event written during another step in the next step, once its state commits", async () => {
  const { hooked, runtime, sessionWritable, streamed } = await createPublishingRuntime();
  const cursor = new SessionStateCursor({
    inbox: { claimSessionHooks: async () => {} },
    serializedContext,
    sessionState: createTestSessionState(),
    sessionWritable,
  });

  await runtime.run(async () => {
    // While Alice's model step runs, her research run opens a helper session.
    await cursor.advance(async (state) => {
      const pending = await writeEarlyRunMessageEventStep({
        message: {
          from: {
            callId: "call-1",
            input: {},
            runId: "run-1",
            sequence: 1,
            stepIndex: 0,
            toolName: "research",
            turnId: "turn-1",
          },
          kind: "agent-started",
          session: { kind: "local", name: "helper", nodeId: "helper", sessionId: "helper-1" },
        },
        serializedContext: state.serializedContext,
        sessionWritable: state.sessionWritable,
      });
      if (pending !== undefined) cursor.deferDispatch(pending);
      return { stateDelta: {} };
    });
    expect(streamed.map((event) => event.type)).toEqual(["agent.started"]);
    expect(hooked).toEqual([]);

    // The next step's first attempt dies after dispatching; the workflow retries it.
    let attempts = 0;
    const nextStep = (state: SessionStepState) =>
      withSessionStateDelta(structuredCloneValues(state), async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("The step's worker restarted.");
        return {};
      });
    await cursor.advance(async (state) => {
      await expect(nextStep(state)).rejects.toThrow("worker restarted");
      return await nextStep(state);
    });

    await cursor.advance(async (state) => {
      expect(state.pendingDispatches).toEqual([]);
      return { stateDelta: {} };
    });
  });

  const [written] = streamed;
  expect(streamed).toHaveLength(1);
  expect(hooked).toEqual([
    { event: written, sessionId: "test-session" },
    { event: written, sessionId: "test-session" },
  ]);
  expect(cursor.serializedContext["test.opened-sessions"]).toEqual(["helper-1"]);
});

/** Each attempt of a step reads its own copy of the input, as the workflow deserializes it. */
function structuredCloneValues(state: SessionStepState): SessionStepState {
  return {
    pendingDispatches: structuredClone(state.pendingDispatches),
    serializedContext: structuredClone(state.serializedContext),
    sessionState: structuredClone(state.sessionState),
    sessionWritable: state.sessionWritable,
  };
}
