import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolvePendingInput } from "#harness/input-requests.js";
import {
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

it("continues the second step past an older approval batch", async () => {
  const events: UnstampedMessageStreamEvent[] = [];
  const gate = vi.fn(async () => ({ changed: true }));
  const read = vi.fn(async () => ({ status: "ready" }));
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const call = modelCalls++;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(call < 2
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: `call-${call}`,
                    toolName: call === 0 ? "gate" : "read",
                    input: "{}",
                  },
                ]
              : [
                  { type: "text-start" as const, id: "reply" },
                  { type: "text-delta" as const, id: "reply", delta: "Your draft is ready." },
                  { type: "text-end" as const, id: "reply" },
                ]),
            {
              type: "finish",
              finishReason: { unified: call < 2 ? "tool-calls" : "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
  const config: ToolLoopHarnessConfig = {
    tools: new Map<string, HarnessToolDefinition>([
      [
        "gate",
        {
          name: "gate",
          description: "Change account",
          inputSchema: jsonSchema({ type: "object" }),
          approval: always(),
          execute: gate,
        },
      ],
      [
        "read",
        {
          name: "read",
          description: "Read draft status",
          inputSchema: jsonSchema({ type: "object" }),
          execute: read,
        },
      ],
    ]),
    resolveModel: async () => model,
    handleEvent: async (event) => {
      events.push(event);
    },
  };
  const initial: HarnessSession = {
    agent: { system: "Test", tools: [], modelReference: { id: "test/model" } },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "diagnosis",
    sessionId: "diagnosis-3494",
    history: [],
  };
  const run = async (session: HarnessSession, input?: StepInput) => {
    const state = getHarnessEmissionState(session.state);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      sessionId: session.sessionId,
      auth: { current: null, initiator: null },
      turn: { id: state.turnId || `turn_${state.sequence}`, sequence: state.sequence },
    });
    return contextStorage.run(ctx, () => createToolLoopHarness(config)(session, input));
  };

  const parked = await run(initial, { message: "Prepare the account change." });
  expect(parked.next).toBeNull();
  expect(gate).not.toHaveBeenCalled();
  const [approval] = getPendingInputBatches(parked.session.state);
  expect(approval?.event?.turnId).toBe("turn_0");
  expect(approval?.requests[0]?.kind).toBe("tool-approval");

  const first = await run(parked.session, { message: "What is the draft status?" });
  expect(typeof first.next).toBe("function");
  expect(read).toHaveBeenCalledTimes(1);
  expect(modelCalls).toBe(2);
  expect(getHarnessEmissionState(first.session.state)).toMatchObject({
    turnId: "turn_1",
    stepIndex: 1,
  });
  expect(first.session.history.at(-1)?.role).toBe("tool");
  const before = events.length;

  const pendingDecision = resolvePendingInput({ session: first.session });
  expect(pendingDecision.outcome).toBe("unresolved");
  const continued = await run(first.session);
  expect(continued.settledTurn?.output).toBe("Your draft is ready.");
  expect(continued.next).toBeNull();
  expect(modelCalls).toBe(3);
  expect(events.slice(before).some((event) => event.type === "turn.completed")).toBe(true);
  expect(getPendingInputBatches(continued.session.state)).toEqual([approval]);
  const continuedObservation = {
    phase: "continued",
    modelCalls,
    emission: getHarnessEmissionState(continued.session.state),
    pendingOwner: approval?.event,
    emittedBySecondStep: events.slice(before).map((event) => event.type),
    firstTurnEvents: events
      .filter(
        (event) => "data" in event && "turnId" in event.data && event.data.turnId === "turn_1",
      )
      .map((event) => event.type),
  };

  // Remove the batch only from a cloned state to isolate causality; this is not a fix.
  const control = removePendingInputBatches(first.session, [approval!]);
  expect(control.history).toBe(first.session.history);
  expect(getHarnessEmissionState(control.state)).toEqual(
    getHarnessEmissionState(first.session.state),
  );
  expect(resolvePendingInput({ session: control }).outcome).toBe("continue");
  const beforeControl = events.length;
  await run(control);
  expect(modelCalls).toBe(4);
  expect(events.slice(beforeControl).some((event) => event.type === "turn.completed")).toBe(true);
  expect(gate).not.toHaveBeenCalled();
  expect(getPendingInputBatches(first.session.state)).toEqual([approval]);
  const controlObservation = {
    phase: "clone-without-batch",
    modelCalls,
    events: events.slice(beforeControl).map((event) => event.type),
    originalStillPending: getPendingInputBatches(first.session.state).length,
    gateExecutions: gate.mock.calls.length,
  };

  const beforeApproval = events.length;
  const approved = await run(continued.session, {
    inputResponses: [{ requestId: approval!.requests[0]!.requestId, optionId: "approve" }],
  });
  expect(gate).toHaveBeenCalledTimes(1);
  expect(getPendingInputBatches(approved.session.state)).toHaveLength(0);
  const approvalObservation = {
    phase: "approve-original-session",
    gateExecutions: gate.mock.calls.length,
    pending: getPendingInputBatches(approved.session.state).length,
    events: events.slice(beforeApproval).map((event) => event.type),
  };
  writeFileSync(
    join(tmpdir(), "eve-3494-diagnosis.json"),
    JSON.stringify({ continuedObservation, controlObservation, approvalObservation }, null, 2),
  );
});
