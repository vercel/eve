import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { SessionIdKey, StepDynamicToolMetadataKey } from "#context/keys.js";
import {
  commitCancelledCoordinationBatch,
  getPendingCoordinationBatch,
} from "#harness/coordination.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";
import {
  clearDurableDynamicCallbacks,
  registerDurableDynamicCallback,
} from "#tools/durable-callbacks.js";

vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

function workflow(
  name: string,
  approval?: HarnessToolDefinition["approval"],
): HarnessToolDefinition {
  return {
    approval,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    workflowId: `workflow//./agent/tools/${name}//execute`,
  };
}

function setup(
  tools: readonly HarnessToolDefinition[],
  overrides: Partial<ToolLoopHarnessConfig> = {},
) {
  const events: UnstampedMessageStreamEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: vi
      .fn()
      .mockImplementationOnce(async () =>
        toolCallsStreamResult(
          tools.map((tool, index) => ({
            input: "{}",
            toolCallId: `call-${index}`,
            toolName: tool.name,
          })),
        ),
      )
      .mockImplementation(async () => textStreamResult("Finished.")),
    modelId: "approval-model",
    provider: "eve-integration-mock",
  });
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    ...overrides,
  };
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "approval-model" },
      system: "Help Alice coordinate her release.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generate-approval-resume-session",
    history: [],
    sessionId: "generate-approval-resume-session",
  };
  const step = (
    session: HarnessSession,
    input?: Parameters<ReturnType<typeof createToolLoopHarness>>[1],
  ) =>
    contextStorage.run(createApprovalContext(), () =>
      createToolLoopHarness(config)(session, input),
    );
  return { events, config, model, step, session };
}

function requests(session: HarnessSession) {
  return getPendingInputBatches(session.state).flatMap((batch) => batch.requests);
}

function workflowResult(callId = "call-0") {
  return {
    runtimeActionResults: [
      { callId, kind: "tool-result" as const, output: "deployed", toolName: "deploy" },
    ],
  };
}

function resultCallIds(session: HarnessSession) {
  return session.history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
      : [],
  );
}

describe("workflow approval resume (real AI SDK)", () => {
  it("opens one resume turn before dispatch and replays accompanying input after completion", async () => {
    const fixture = setup([workflow("deploy", always())]);
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    expect(getPendingCoordinationBatch(initial.session.state)).toBeUndefined();
    const [request] = requests(initial.session);
    expect(request).toBeDefined();
    const start = fixture.events.length;
    const approved = await fixture.step(initial.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
      message: "Tell Alice when deployment finishes.",
    });
    expect(
      getPendingCoordinationBatch(approved.session.state)?.tasks.map((task) => task.callId),
    ).toEqual(["call-0"]);
    const resumedTurn = getHarnessEmissionState(approved.session.state).turnId;
    expect(resumedTurn).not.toBe("");
    expect(
      fixture.events.slice(start).filter((event) => event.type === "turn.started"),
    ).toMatchObject([{ data: { turnId: resumedTurn } }]);
    const completed = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(completed.session)).toEqual(["call-0"]);
    expect(fixture.model.doStreamCalls).toHaveLength(2);
    expect(
      fixture.events.slice(start).filter((event) => event.type === "step.started"),
    ).toMatchObject([
      { data: { turnId: resumedTurn, stepIndex: 0 } },
      { data: { turnId: resumedTurn, stepIndex: 1 } },
    ]);
    expect(JSON.stringify(fixture.model.doStreamCalls[1]!.prompt)).not.toContain("Tell Alice");
    expect(typeof completed.next).toBe("function");
    const followUp = await fixture.step(completed.session);
    expect(JSON.stringify(followUp.session.history)).toContain(
      "Tell Alice when deployment finishes.",
    );
    expect(fixture.events.filter((event) => event.type === "input.resolved")).toHaveLength(1);
  });

  it("keeps approved calls runnable when the resume turn adds user instructions", async () => {
    const fixture = setup([workflow("deploy", always())], {
      handleEvent: async (event, messages) => {
        const ctx = contextStorage.getStore();
        if (!(ctx instanceof ContextContainer)) throw new Error("Missing test context.");
        await dispatchDynamicInstructionEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: [
            {
              eventNames: ["turn.started"],
              events: {
                "turn.started": () =>
                  defineInstructions({ role: "user", content: "Keep Alice informed." }),
              },
              logicalPath: "instructions/release.ts",
              slug: "release",
              sourceId: "instructions/release.ts",
              sourceKind: "module",
            },
          ],
        });
      },
    });
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const approved = await fixture.step(initial.session, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    });
    expect(getPendingCoordinationBatch(approved.session.state)?.tasks).toHaveLength(1);
    const completed = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(completed.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.model.doStreamCalls.at(-1)?.prompt)).toContain(
      "Keep Alice informed.",
    );
  });

  it("never dispatches a denied workflow", async () => {
    const fixture = setup([workflow("deploy", always())]);
    const initial = await fixture.step(fixture.session, { message: "Prepare Alice's deployment." });
    const cancelled = await fixture.step(initial.session, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "cancel",
        requestId: request.requestId,
      })),
    });
    expect(getPendingCoordinationBatch(cancelled.session.state)).toBeUndefined();
    expect(resultCallIds(cancelled.session)).toEqual(["call-0"]);
  });

  it("never dispatches an automatically denied workflow", async () => {
    const fixture = setup([workflow("deploy", () => "denied")]);
    const initial = await fixture.step(fixture.session, { message: "Review Alice's deployment." });
    expect(getPendingCoordinationBatch(initial.session.state)).toBeUndefined();
    expect(requests(initial.session)).toEqual([]);
    expect(resultCallIds(initial.session)).toEqual(["call-0"]);
  });

  it("runs ungated siblings first and dispatches only the approved workflow", async () => {
    const fixture = setup([
      workflow("deploy", always()),
      workflow("archive", always()),
      workflow("status"),
    ]);
    const initial = await fixture.step(fixture.session, {
      message: "Prepare Alice's release and check status.",
    });
    expect(
      getPendingCoordinationBatch(initial.session.state)?.tasks.map((task) => task.callId),
    ).toEqual(["call-2"]);
    const ordinary = await fixture.step(initial.session, {
      runtimeActionResults: [
        { callId: "call-2", kind: "tool-result", output: "healthy", toolName: "status" },
      ],
    });
    const approved = await fixture.step(ordinary.session, {
      inputResponses: requests(ordinary.session).map((request) => ({
        optionId: request.action.toolName === "deploy" ? "approve" : "cancel",
        requestId: request.requestId,
      })),
    });
    expect(
      getPendingCoordinationBatch(approved.session.state)?.tasks.map((task) => task.callId),
    ).toEqual(["call-0"]);
    const completed = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(completed.session).sort()).toEqual(["call-0", "call-1", "call-2"]);
    expect(getPendingCoordinationBatch(completed.session.state)).toBeUndefined();
  });

  it("restores an approved dynamic sibling on a cold workflow continuation", async () => {
    const execute = vi.fn(async () => "notified");
    const preparedTurns: string[] = [];
    const fixture = setup(
      [
        workflow("deploy", always()),
        {
          name: "notify",
          description: "Notify Bob.",
          approval: always(),
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => {
            throw new Error("The authored fallback must not execute.");
          },
        },
      ],
      {
        prepareApprovalTurn: async (event) => {
          preparedTurns.push(event.turnId);
        },
        resolveStepDynamicTools: async ({ ctx }) => {
          registerDurableDynamicCallback({
            owner: {
              sessionId: ctx.require(SessionIdKey),
              scope: "step",
              resolverSlug: "notifications",
              entryKey: "notify",
              name: "notify",
            },
            phase: "execute",
            callback: execute,
          });
          ctx.set(StepDynamicToolMetadataKey, [
            {
              name: "notify",
              description: "Notify Bob.",
              inputSchema: { type: "object" },
              resolverSlug: "notifications",
              entryKey: "notify",
              callbacks: { execute: { closure: {} } },
            },
          ]);
        },
      },
    );
    const initial = await fixture.step(fixture.session, {
      message: "Deploy Alice's release and notify Bob.",
    });
    const origin = getPendingInputBatches(initial.session.state)[0]!.event!.turnId;
    const approved = await fixture.step(initial.session, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    });
    expect(execute).not.toHaveBeenCalled();
    clearDurableDynamicCallbacks(initial.session.sessionId);
    const completed = await fixture.step(
      JSON.parse(JSON.stringify(approved.session)),
      workflowResult(),
    );
    expect(preparedTurns).toEqual([origin, origin]);
    expect(execute).toHaveBeenCalledOnce();
    expect(resultCallIds(completed.session)).toEqual(["call-0", "call-1"]);
    expect(JSON.stringify(completed.session.history)).toContain("notified");
    expect(fixture.events.filter((event) => event.type === "input.resolved")).toHaveLength(1);
    clearDurableDynamicCallbacks(initial.session.sessionId);
  });

  it("starts an approved workflow and applies the session budget to the next model call", async () => {
    const fixture = setup([workflow("deploy", always())]);
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const totals = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 1,
      sawCost: false,
    };
    const exhausted = setTurnUsageState(
      { ...initial.session, limits: { maxInputTokensPerSession: 12 } },
      {
        ...totals,
        session: totals,
        turnId: "turn_0",
      },
    );
    const approved = await fixture.step(exhausted, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    });
    expect(
      getPendingCoordinationBatch(approved.session.state)?.tasks.map((task) => task.callId),
    ).toEqual(["call-0"]);
    const limited = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(limited.session)).toEqual(["call-0"]);
    const [limit] = requests(limited.session);
    expect(limit?.kind).toBe("session-limit");
    const modelCalls = fixture.model.doStreamCalls.length;
    const continued = await fixture.step(limited.session, {
      inputResponses: [{ optionId: "continue", requestId: limit!.requestId }],
    });
    expect(fixture.model.doStreamCalls).toHaveLength(modelCalls + 1);
    expect(resultCallIds(continued.session)).toEqual(["call-0"]);
  });

  it("settles approved siblings without executing them when workflow coordination is cancelled", async () => {
    const execute = vi.fn(async () => "notified");
    const fixture = setup([
      workflow("deploy", always()),
      {
        name: "notify",
        description: "Notify Bob.",
        approval: always(),
        inputSchema: jsonSchema({ type: "object" }),
        execute,
      },
    ]);
    const initial = await fixture.step(fixture.session, {
      message: "Deploy Alice's release and notify Bob.",
    });
    const approved = await fixture.step(initial.session, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    });
    const cancelled = commitCancelledCoordinationBatch(approved.session);
    expect(resultCallIds(cancelled).sort()).toEqual(["call-0", "call-1"]);
    await fixture.step(cancelled, {
      message: "Alice cancelled the release. Summarize the status.",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
