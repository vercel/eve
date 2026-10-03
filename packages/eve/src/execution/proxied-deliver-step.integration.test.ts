import { beforeEach, describe, expect, it, vi } from "vitest";

const { resumeHook } = vi.hoisted(() => ({ resumeHook: vi.fn(async () => {}) }));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  resumeHook,
}));

import type { DeliverHookPayload } from "#channel/types.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "release-session",
};

const options = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

function answer(requestId: string): DeliverHookPayload {
  return { kind: "deliver", payloads: [{ inputResponses: [{ optionId: "yes", requestId }] }] };
}

/** A session whose turn 1 is open, and the events it publishes. */
function openTurn(): { cursor: SessionStateCursor; events: MessageStreamEvent[] } {
  const emissionState = { sequence: 2, sessionStarted: true, stepIndex: 0, turnId: "turn_1" };
  const events: MessageStreamEvent[] = [];
  const decoder = new TextDecoder();
  const cursor = new SessionStateCursor({
    history: [],
    inbox: { claimSessionHooks: async () => {} },
    serializedContext,
    sessionState: createTestSessionState({
      emissionState,
      sessionId: "release-session",
      snapshot: {
        session: {
          agent: { system: "" },
          continuationToken: "test-token",
          sessionId: "release-session",
          state: { "eve.harness.emission": emissionState },
        },
      },
    }),
    sessionWritable: new WritableStream<Uint8Array>({
      write(chunk) {
        events.push(JSON.parse(decoder.decode(chunk)) as MessageStreamEvent);
      },
    }),
  });
  return { cursor, events };
}

/** A workflow tool run of `turnId` asks its question with `ctx.ask()`. */
async function ask(
  cursor: SessionStateCursor,
  name: string,
  turnId = "turn_1",
  taskId?: string,
): Promise<void> {
  const from: WorkflowToolRunRef = {
    callId: `${name}-call`,
    input: {},
    runId: `${name}-run`,
    sequence: 2,
    stepIndex: 0,
    ...(taskId !== undefined && { taskId }),
    toolName: name,
    turnId,
  };
  await handleWorkflowToolRunMessage({
    cursor,
    message: {
      from,
      kind: "request",
      replyTo: `${name}-question`,
      request: { control: `${name}-control`, kind: "ask", request: { options, prompt: name } },
    },
  });
}

async function deliver(cursor: SessionStateCursor, delivery: DeliverHookPayload) {
  return await cursor.advance((state) => routeDeliverToChildren({ delivery, ...state }));
}

describe("routeProxiedDeliver", () => {
  beforeEach(() => {
    resumeHook.mockClear();
  });

  it("parks the open turn again while one of its ctx.ask() questions is unanswered", async () => {
    // One step of Alice's release turn calls two workflow tools, and each asks
    // her a question with ctx.ask(). She answers the deploy question first.
    const { cursor, events } = openTurn();
    const runtime = await createTestRuntime({ agent: { name: "release" } });
    await runtime.run(async () => {
      await ask(cursor, "deploy");
      await ask(cursor, "notify");
      expect(events.map((event) => event.type)).toEqual([
        "input.requested",
        "turn.waiting",
        "input.requested",
        "turn.waiting",
      ]);

      events.length = 0;
      const partial = await deliver(cursor, answer("deploy-question"));
      expect(partial).toMatchObject({ kind: "continue", remainder: undefined });
      expect(events.map((event) => event.type)).toEqual(["input.resolved", "turn.waiting"]);
      expect(events[1]?.data).toMatchObject({ on: "input", sequence: 2, turnId: "turn_1" });
      expect(resumeHook).toHaveBeenCalledWith(
        "deploy-control",
        expect.objectContaining({ kind: "answer", requestId: "deploy-question" }),
      );
      expect([...getProxyInputRequests(cursor.sessionState.snapshot.session.state).keys()]).toEqual(
        ["notify-question"],
      );

      // The last answer leaves the turn nothing to wait on, so it does not park.
      events.length = 0;
      await deliver(cursor, answer("notify-question"));
      expect(events.map((event) => event.type)).toEqual(["input.resolved"]);
      expect(getProxyInputRequests(cursor.sessionState.snapshot.session.state).size).toBe(0);
    });
  });

  it("does not park the open turn for a question an earlier turn's task asked", async () => {
    const { cursor, events } = openTurn();
    const runtime = await createTestRuntime({ agent: { name: "release" } });
    await runtime.run(async () => {
      await ask(cursor, "audit", "turn_0", "audit-task");
      await ask(cursor, "deploy");

      events.length = 0;
      await deliver(cursor, answer("deploy-question"));
      expect(events.map((event) => event.type)).toEqual(["input.resolved"]);
      expect([...getProxyInputRequests(cursor.sessionState.snapshot.session.state).keys()]).toEqual(
        ["audit-question"],
      );
    });
  });
});
