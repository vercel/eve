import { jsonSchema } from "ai";
import type { ApprovalContext } from "#approval/definition.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { resolveDynamicInstructions } from "#context/dynamic-instruction-lifecycle.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { SessionIdKey, StepDynamicToolMetadataKey } from "#context/keys.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { cancel } from "#harness/session-machine/transitions.js";
import { runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { withPublished } from "#internal/testing/session-machine.js";
import { openInputs } from "#protocol/session-projection.js";
import { createProjectionRecorder } from "#internal/testing/session-projection-recorder.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
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
  const recorder = createProjectionRecorder();
  const listen: NonNullable<ToolLoopHarnessConfig["handleEvent"]> =
    overrides.handleEvent ??
    (async (event) => {
      events.push(event);
    });
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    ...overrides,
    handleEvent: async (event, messages) => {
      recorder.record(event);
      await listen(event, messages);
    },
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
    contextStorage.run(recorder.enter(createApprovalContext()), () =>
      createToolLoopHarness(config)(session, input),
    );
  return { events, config, model, recorder, step, session };
}

/** What the session asks and still awaits. */
function requests(session: HarnessSession) {
  return openInputs(storedProjection(session.state)).map((input) => input.request);
}

/** `session.cancel()`, through the machine's transition. */
async function cancelTurn(
  session: HarnessSession,
  record: (event: UnstampedMessageStreamEvent) => void,
): Promise<HarnessSession> {
  const published: UnstampedMessageStreamEvent[] = [];
  const cancelled = await applyTransition(
    session,
    cancel(sessionView(storedProjection(session.state), session.state)),
    async (event) => {
      published.push(event);
      record(event);
    },
  );
  return withPublished(cancelled, published);
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
  it.each(["workflow", "agent"])("rechecks an approved %s call before dispatch", async (kind) => {
    let frozen = false;
    const policy = vi.fn((ctx: ApprovalContext) =>
      frozen && ctx.session.auth.current?.principalId === "user-1"
        ? { type: "denied" as const, reason: "A change freeze is in effect." }
        : ("user-approval" as const),
    );
    const tool = {
      ...workflow("deploy", policy),
      ...(kind === "agent" && { workflowId: "workflow//./agent/subagents/release//run" }),
    };
    const fixture = setup([tool]);
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const [request] = requests(initial.session);
    expect(request).toBeDefined();
    frozen = true;
    const start = fixture.events.length;
    const approved = await fixture.step(initial.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });
    expect(runtimeWait(approved.session.state)).toBeUndefined();
    expect(policy.mock.calls.at(-1)?.[0].session.auth.current?.principalId).toBe("user-1");
    expect(
      fixture.events.slice(start).filter((event) => event.type === "action.result"),
    ).toMatchObject([
      {
        data: {
          status: "rejected",
          result: {
            output: {
              code: "TOOL_EXECUTION_DENIED",
              message: "A change freeze is in effect.",
            },
          },
        },
      },
    ]);
    expect(
      approved.session.history
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .filter((part) => part.type === "tool-result"),
    ).toMatchObject([
      { output: { type: "execution-denied", reason: "A change freeze is in effect." } },
    ]);
  });

  it("resumes the held turn before dispatch and replays accompanying input after completion", async () => {
    const fixture = setup([workflow("deploy", always())]);
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    expect(runtimeWait(initial.session.state)).toBeUndefined();
    const [request] = requests(initial.session);
    expect(request).toBeDefined();
    const start = fixture.events.length;
    const approved = await fixture.step(initial.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
      message: "Tell Alice when deployment finishes.",
    });
    expect(runtimeWait(approved.session.state)?.tasks.map((task) => task.callId)).toEqual([
      "call-0",
    ]);
    // The approval held its turn, so answering it resumes that turn.
    const resumedTurn = fixture.recorder.position.turnId;
    expect(resumedTurn).toBe("turn_0");
    expect(
      fixture.events.slice(start).filter((event) => event.type === "turn.started"),
    ).toHaveLength(0);
    const completed = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(completed.session)).toEqual(["call-0"]);
    expect(fixture.model.doStreamCalls).toHaveLength(2);
    // The step that dispatches the approved workflow starts but calls no model; the next reads
    // its result, and the input that came with the approval replays after it.
    expect(
      fixture.events.slice(start).filter((event) => event.type === "step.started"),
    ).toMatchObject([{ data: { turnId: resumedTurn } }, { data: { turnId: resumedTurn } }]);
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
        if (event.type !== "session.started" && event.type !== "turn.started") return;
        await resolveDynamicInstructions({
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
    expect(runtimeWait(approved.session.state)?.tasks).toHaveLength(1);
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
    expect(runtimeWait(cancelled.session.state)).toBeUndefined();
    expect(resultCallIds(cancelled.session)).toEqual(["call-0"]);
  });

  it("never dispatches an automatically denied workflow", async () => {
    const fixture = setup([workflow("deploy", () => "denied")]);
    const initial = await fixture.step(fixture.session, { message: "Review Alice's deployment." });
    expect(runtimeWait(initial.session.state)).toBeUndefined();
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
    expect(runtimeWait(initial.session.state)?.tasks.map((task) => task.callId)).toEqual([
      "call-2",
    ]);
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
    expect(runtimeWait(approved.session.state)?.tasks.map((task) => task.callId)).toEqual([
      "call-0",
    ]);
    const completed = await fixture.step(approved.session, workflowResult());
    expect(resultCallIds(completed.session).sort()).toEqual(["call-0", "call-1", "call-2"]);
    expect(runtimeWait(completed.session.state)).toBeUndefined();
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
        participants: {
          selectModel: async () => {},
          restoreStep: async ({ at, parked }) => {
            if (parked) preparedTurns.push(at.turnId);
            const ctx = contextStorage.getStore()!;
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
      },
    );
    const initial = await fixture.step(fixture.session, {
      message: "Deploy Alice's release and notify Bob.",
    });
    const origin = openInputs(storedProjection(initial.session.state))[0]!.turnId;
    const approved = await fixture.step(initial.session, {
      inputResponses: requests(initial.session).map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    });
    // The approved workflow runs first; its sibling waits for its result.
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
    expect(runtimeWait(approved.session.state)?.tasks.map((task) => task.callId)).toEqual([
      "call-0",
    ]);
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
    const cancelled = await cancelTurn(approved.session, fixture.recorder.record);
    expect(resultCallIds(cancelled).sort()).toEqual(["call-0", "call-1"]);
    await fixture.step(cancelled, {
      message: "Alice cancelled the release. Summarize the status.",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
