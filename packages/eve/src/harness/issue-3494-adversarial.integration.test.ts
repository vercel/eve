import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, expect, it, vi } from "vitest";
import type { ApprovalResponsePolicy } from "#approval/definition.js";
import {
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
} from "#harness/approval-candidates.js";
import { setPendingAuthorization } from "#harness/authorization.js";
import { z } from "zod";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { encodeTaskCreator } from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { createTurnStartedEvent } from "#protocol/message.js";

// Diagnostic probes assert desired outcomes. Pending state is created by the
// real harness and SDK; only provider output and runtime result delivery are scripted.
type Reply = string | Array<{ toolName: string; input?: unknown; providerExecuted?: true }>;
const calls = (...names: string[]): Reply => names.map((toolName) => ({ toolName }));
const reports: unknown[] = [];
afterAll(() => {
  if (process.env.EVE_3494_REPORT === "1")
    console.log("EVE_3494_REPORT=" + JSON.stringify(reports));
});

function fixture(
  name: string,
  responseAuthorized: boolean | ApprovalResponsePolicy = false,
  outputLimit?: number,
  outputSchema?: HarnessSession["outputSchema"],
) {
  const script: Reply[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  const executions: string[] = [];
  const steps: unknown[] = [];
  const prompts: unknown[] = [];
  let modelCalls = 0;
  let session: HarnessSession = {
    agent: { system: "Test", tools: [], modelReference: { id: "test/model" } },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: name,
    sessionId: name,
    history: [],
    limits: outputLimit === undefined ? undefined : { maxOutputTokensPerSession: outputLimit },
    outputSchema,
  };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const call = modelCalls++;
      prompts.push(options.prompt);
      const reply = script.shift();
      if (reply === undefined) throw new Error("Provider script exhausted");
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(typeof reply === "string"
              ? [
                  { type: "text-start" as const, id: "answer" },
                  { type: "text-delta" as const, id: "answer", delta: reply },
                  { type: "text-end" as const, id: "answer" },
                ]
              : reply.flatMap((tool, index) => [
                  {
                    type: "tool-call" as const,
                    toolCallId: `call-${call}-${index}`,
                    toolName: tool.toolName,
                    input: JSON.stringify(tool.input ?? { n: 1 }),
                    providerExecuted: tool.providerExecuted,
                  },
                  ...(tool.providerExecuted
                    ? [
                        {
                          type: "tool-result" as const,
                          toolCallId: `call-${call}-${index}`,
                          toolName: tool.toolName,
                          result: { marker: "provider-RESULT" },
                          providerExecuted: true as const,
                        },
                      ]
                    : []),
                ])),
            {
              type: "finish",
              finishReason: {
                unified: typeof reply === "string" ? "stop" : "tool-calls",
                raw: "stop",
              },
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
  const tools = new Map<string, HarnessToolDefinition>();
  for (const toolName of ["gateA", "gateB", "read", "write", "fail"]) {
    tools.set(toolName, {
      name: toolName,
      description: toolName,
      inputSchema: z.object({ n: z.number() }),
      ...(toolName.startsWith("gate")
        ? {
            approval: responseAuthorized
              ? {
                  request: always(),
                  response:
                    typeof responseAuthorized === "function"
                      ? responseAuthorized
                      : async () => ({ status: "allowed" as const }),
                }
              : always(),
          }
        : {}),
      execute: async () => {
        executions.push(toolName);
        if (toolName === "fail") throw new Error("Recoverable tool failure");
        return { marker: `${toolName}-RESULT` };
      },
    });
  }
  tools.set("workflow", {
    name: "workflow",
    description: "Deferred workflow",
    inputSchema: jsonSchema({ type: "object" }),
    workflowId: "diagnostic-workflow",
  });
  const restoredTurns: string[] = [];
  const harness = createToolLoopHarness({
    prepareApprovalTurn: async (event) => {
      const ctx = new ContextContainer();
      ctx.set(ConnectionRegistryKey, new ConnectionRegistryImpl([]));
      await bindDynamicConnections(ctx, {
        dynamicConnectionResolvers: [
          {
            slug: "notes",
            sourceId: "notes",
            sourceKind: "module",
            logicalPath: "connections/notes.ts",
            eventNames: ["turn.started"],
            events: {
              "turn.started": (event) => {
                restoredTurns.push(
                  (event as ReturnType<typeof createTurnStartedEvent>).data.turnId,
                );
                return null;
              },
            },
          },
        ],
      }).dispatch(createTurnStartedEvent(event));
    },
    mode: "conversation",
    capabilities: { requestInput: true },
    tools,
    resolveModel: async () => model,
    handleEvent: async (event) => {
      events.push(event);
    },
  });
  async function step(input?: StepInput): Promise<StepResult> {
    const before = events.length;
    const beforeCalls = modelCalls;
    const emission = getHarnessEmissionState(session.state);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      sessionId: session.sessionId,
      auth: { current: null, initiator: null },
      turn: { id: emission.turnId || `turn_${emission.sequence}`, sequence: emission.sequence },
    });
    const result = await contextStorage.run(ctx, () => harness(session, input));
    session = result.session;
    steps.push({
      input,
      modelCalls: modelCalls - beforeCalls,
      events: events.slice(before),
      next: typeof result.next === "function" ? "continue" : result.next,
      settledTurn: result.settledTurn,
      historyLastRole: session.history.at(-1)?.role,
      emission: getHarnessEmissionState(session.state),
      deferred: session.state?.["eve.runtime.deferredStepInput"],
      pending: getPendingInputBatches(session.state).map((batch) => ({
        owner: batch.event,
        requests: batch.requests.map((r) => ({
          id: r.requestId,
          tool: r.action.toolName,
          kind: r.kind,
        })),
      })),
    });
    return result;
  }
  async function drive(input?: StepInput) {
    let result = await step(input);
    for (let count = 0; typeof result.next === "function"; count++) {
      if (count >= 10) throw new Error("Continuation did not settle within 10 steps");
      result = await step();
    }
    return result;
  }
  const report = { name, steps, executions, prompts };
  reports.push(report);
  return {
    script,
    restoredTurns,
    executions,
    events,
    step,
    drive,
    get session() {
      return session;
    },
    updateSession(update: (session: HarnessSession) => HarnessSession) {
      session = update(session);
    },
    pending: () => getPendingInputBatches(session.state).flatMap((b) => b.requests),
    async gate(...names: string[]) {
      script.push(calls(...names));
      await drive({ message: `Prepare ${names.join(" and ")}.` });
      expect(this.pending().filter((r) => r.kind === "tool-approval")).toHaveLength(names.length);
      expect(executions).toHaveLength(0);
    },
    respond(tool: string, optionId = "approve"): StepInput {
      const request = this.pending().find((r) => r.action.toolName === tool);
      if (!request) throw new Error(`Missing request for ${tool}`);
      return { inputResponses: [{ requestId: request.requestId, optionId }] };
    },
    async finishRuntime() {
      const batch = getPendingCoordinationBatch(session.state);
      if (!batch) throw new Error("Expected actual pending coordination batch");
      return drive({
        runtimeActionResults: batch.tasks.map((r) => ({
          kind: "tool-result" as const,
          callId: r.callId,
          toolName: r.toolName,
          output: { marker: "runtime-RESULT" },
        })),
      });
    },
  };
}

for (const variant of [
  "read",
  "write",
  "fail",
  "parallel",
  "invalid",
  "response-authorized",
] as const) {
  it(`finishes unrelated ${variant} tool turn while an approval stays open`, async () => {
    const f = fixture(variant, variant === "response-authorized");
    await f.gate("gateA");
    f.script.push(
      variant === "parallel"
        ? calls("read", "write")
        : variant === "invalid"
          ? [{ toolName: "read", input: { n: "invalid" } }]
          : calls(variant === "response-authorized" ? "read" : variant),
      "FINAL",
    );
    const result = await f.drive({ message: "Do the unrelated work." });
    expect(f.pending()).toHaveLength(1);
    expect(f.executions).not.toContain("gateA");
    const expectedExecutions = {
      read: ["read"],
      write: ["write"],
      fail: ["fail"],
      parallel: ["read", "write"],
      invalid: [],
      "response-authorized": ["read"],
    }[variant];
    expect([...f.executions].sort()).toEqual(expectedExecutions.sort());
    expect(result.settledTurn?.output).toBe("FINAL");
  });
}

for (const variant of ["approve", "cancel"] as const) {
  it(`continues after ${variant} of one independent approval while another remains`, async () => {
    const f = fixture(`sibling-${variant}`);
    await f.gate("gateA");
    f.script.push(calls("gateB"));
    await f.drive({ message: "Also prepare B." });
    expect(f.pending()).toHaveLength(2);
    f.script.push(calls("read"), "FINAL");
    const result = await f.drive(f.respond("gateB", variant));
    expect(f.pending().map((r) => r.action.toolName)).toEqual(["gateA"]);
    expect(f.executions.filter((x) => x === "gateB")).toHaveLength(variant === "approve" ? 1 : 0);
    expect(result.settledTurn?.output).toBe("FINAL");
  });
}

it("interprets a completed workflow result while an earlier approval remains", async () => {
  const f = fixture("workflow");
  await f.gate("gateA");
  f.script.push(calls("workflow"), "FINAL");
  await f.drive({ message: "Run unrelated workflow." });
  const result = await f.finishRuntime();
  expect(JSON.stringify(result.session.history)).toContain("runtime-RESULT");
  expect(f.pending()).toHaveLength(1);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("completes a plain tool turn without any pending input [control]", async () => {
  const f = fixture("control-no-pending");
  f.script.push(calls("read"), "FINAL");
  expect((await f.drive({ message: "Read the status." })).settledTurn?.output).toBe("FINAL");
});

it("completes a text-only follow-up with a pending approval [control]", async () => {
  const f = fixture("control-text");
  await f.gate("gateA");
  f.script.push("FINAL");
  expect((await f.drive({ message: "Explain the change." })).settledTurn?.output).toBe("FINAL");
  expect(f.pending()).toHaveLength(1);
});

it("finishes after resolving the only approval [control]", async () => {
  const f = fixture("control-resolve-all");
  await f.gate("gateA");
  f.script.push(calls("read"), "FINAL");
  expect((await f.drive(f.respond("gateA"))).settledTurn?.output).toBe("FINAL");
  expect(f.executions.filter((x) => x === "gateA")).toHaveLength(1);
  expect(f.pending()).toHaveLength(0);
});

it("finishes a deferred workflow without pending input [control]", async () => {
  const f = fixture("control-workflow");
  f.script.push(calls("workflow"), "FINAL");
  await f.drive({ message: "Run the workflow." });
  expect((await f.finishRuntime()).settledTurn?.output).toBe("FINAL");
});

it("accumulates approvals from one batch across separate deliveries [control]", async () => {
  const f = fixture("control-partial-batch");
  await f.gate("gateA", "gateB");
  await f.drive(f.respond("gateA"));
  expect(f.executions).toHaveLength(0);
  f.script.push("FINAL");
  expect((await f.drive(f.respond("gateB"))).settledTurn?.output).toBe("FINAL");
  expect(f.executions.filter((x) => x.startsWith("gate"))).toHaveLength(2);
});

it("finishes an unrelated tool turn carrying a partial approval response", async () => {
  const f = fixture("partial-response-with-followup");
  await f.gate("gateA", "gateB");
  f.script.push(calls("read"), "FINAL");
  const result = await f.drive({
    ...f.respond("gateA"),
    message: "While B waits, read the status.",
  });
  expect(f.executions).toEqual(["read"]);
  expect(f.pending()).toHaveLength(2);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("finishes after a stale approval response becomes a follow-up message", async () => {
  const f = fixture("stale-response");
  await f.gate("gateA");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Also prepare B." });
  const old = f.respond("gateB", "cancel");
  f.script.push("Cancelled.");
  await f.drive(old);
  f.script.push(calls("read"), "FINAL");
  const result = await f.drive(old);
  expect(f.executions).toEqual(["read"]);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("reaches the next budget prompt after a grant while an earlier approval remains", async () => {
  const f = fixture("session-limit-grant", false, 1);
  await f.gate("gateA");
  await f.drive({ message: "Read the status." });
  expect(f.pending().map((r) => r.kind)).toContain("session-limit");
  f.script.push(calls("read"));
  const result = await f.drive(f.respond("session_limit_continuation", "continue"));
  expect(f.executions).toEqual(["read"]);
  expect(result.next).toBeNull();
  expect(f.pending().map((r) => r.kind)).toEqual(["tool-approval", "session-limit"]);
});

for (const variant of ["fail", "invalid"]) {
  it(`recovers from ${variant} without pending input [control]`, async () => {
    const f = fixture(`control-${variant}`);
    f.script.push(
      variant === "invalid" ? [{ toolName: "read", input: { n: "invalid" } }] : calls("fail"),
      "FINAL",
    );
    expect((await f.drive({ message: "Try the tool." })).settledTurn?.output).toBe("FINAL");
    if (variant === "invalid") expect(f.executions).toHaveLength(0);
  });
}

it("settles both independent approval batches and a deferred follow-up [control]", async () => {
  const f = fixture("control-resolve-multiple");
  await f.gate("gateA");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Also prepare B." });
  f.script.push("First approved.", "Second approved.", calls("read"), "FINAL");
  const result = await f.drive({
    inputResponses: [...f.respond("gateA").inputResponses!, ...f.respond("gateB").inputResponses!],
    message: "Then read the status.",
  });
  expect(f.executions.filter((x) => x.startsWith("gate"))).toHaveLength(2);
  expect(f.pending()).toHaveLength(0);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("keeps same-turn approval blocked when its parallel workflow finishes [control]", async () => {
  const f = fixture("control-same-turn-workflow-and-approval");
  f.script.push(calls("gateA", "workflow"));
  await f.drive({ message: "Prepare change and run workflow together." });
  const result = await f.finishRuntime();
  expect(result.next).toBeNull();
  expect(f.pending()).toHaveLength(1);
  expect(f.executions).not.toContain("gateA");
  // Resolving the owning request must still recover the held tool transcript.
  f.script.push("FINAL");
  expect((await f.drive(f.respond("gateA"))).settledTurn?.output).toBe("FINAL");
  expect(f.executions).toEqual(["gateA"]);
});

it("settles a text-only follow-up carrying a partial approval response", async () => {
  const f = fixture("partial-response-with-text");
  await f.gate("gateA", "gateB");
  f.script.push("FINAL");
  const result = await f.drive({
    ...f.respond("gateA"),
    message: "Explain the change while B waits.",
  });
  expect(f.executions).toHaveLength(0);
  expect(f.events.some((e) => e.type === "message.completed")).toBe(true);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("reaches the next budget prompt after a grant without an older approval [control]", async () => {
  const f = fixture("control-session-limit", false, 1);
  f.script.push("Initial text.");
  await f.drive({ message: "Say hello." });
  await f.drive({ message: "Read the status." });
  expect(f.pending().map((r) => r.kind)).toEqual(["session-limit"]);
  f.script.push(calls("read"));
  await f.drive(f.respond("session_limit_continuation", "continue"));
  expect(f.executions).toEqual(["read"]);
  expect(f.pending().map((r) => r.kind)).toEqual(["session-limit"]);
  expect(f.pending()[0]?.requestId).toContain(":output:2");
});

for (const pending of [true, false]) {
  it(`continues after a provider-executed result ${pending ? "with pending approval" : "[control]"}`, async () => {
    const f = fixture(`provider-${pending}`);
    if (pending) await f.gate("gateA");
    f.script.push([{ toolName: "read", providerExecuted: true }], "FINAL");
    const first = await f.step({ message: "Look it up." });
    expect(first.session.history.at(-1)?.role).toBe("assistant");
    expect(typeof first.next).toBe("function");
    const result = await f.drive();
    expect(f.executions).toHaveLength(0);
    expect(JSON.stringify(result.session.history)).toContain("provider-RESULT");
    expect(result.settledTurn?.output).toBe("FINAL");
  });
}

it("settles final_output alongside an ordinary tool with older approval [control]", async () => {
  const f = fixture("control-final-output", false, undefined, {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  });
  await f.gate("gateA");
  f.script.push([{ toolName: "read" }, { toolName: "final_output", input: { status: "ready" } }]);
  const result = await f.drive({
    message: "Read the status and return it.",
  });
  expect(result.settledTurn?.output).toEqual({ status: "ready" });
  expect(f.executions).toEqual(["read"]);
  expect(f.pending()).toHaveLength(1);
});

it("continues after responder-authorized approval with an older approval still open", async () => {
  const f = fixture("authorized-sibling", true);
  await f.gate("gateA");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Also prepare B." });
  f.script.push(calls("read"), "FINAL");
  const result = await f.drive({
    attributedInputResponses: f.respond("gateB").inputResponses!.map((response) => ({
      response,
      auth: {
        attributes: {},
        authenticator: "test",
        issuer: "test",
        principalId: "user-1",
        principalType: "user" as const,
      },
    })),
  });
  expect(f.executions).toEqual(["gateB", "read"]);
  expect(f.pending().map((r) => r.action.toolName)).toEqual(["gateA"]);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("continues after responder-authorized approval of the older batch", async () => {
  const f = fixture("authorized-older-sibling", true);
  await f.gate("gateA");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Also prepare B." });
  expect(f.pending().map((request) => request.action.toolName)).toEqual(["gateA", "gateB"]);
  f.script.push(calls("read"), "FINAL");
  const response = f.respond("gateA").inputResponses![0]!;
  const result = await f.drive({
    attributedInputResponses: [
      {
        response,
        auth: {
          attributes: {},
          authenticator: "test",
          issuer: "test",
          principalId: "user-1",
          principalType: "user",
        },
      },
    ],
  });
  expect(f.executions).toEqual(["gateA", "read"]);
  expect(f.pending().map((request) => request.action.toolName)).toEqual(["gateB"]);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it.each(["rejected", "failed", "timed-out"] as const)(
  "finishes a %s response attempt without starting a turn and permits retry",
  async (outcome) => {
    let allowed = false;
    const policy = vi.fn(() => {
      if (allowed) return { status: "allowed" as const };
      if (outcome === "failed") throw new Error("Policy unavailable");
      return { status: "rejected" as const, reason: "Alice needs Bob's approval." };
    });
    const f = fixture(`response-${outcome}`, policy);
    await f.gate("gateA");
    const input = {
      attributedInputResponses: f.respond("gateA").inputResponses!.map((response) => ({
        response,
        auth: {
          attributes: {},
          authenticator: "test",
          issuer: "test",
          principalId: "alice",
          principalType: "user" as const,
        },
      })),
    };
    const start = f.events.length;
    const ingested = await f.step(input);
    expect(typeof ingested.next).toBe("function");
    expect(f.events.slice(start).map((event) => event.type)).toEqual(["approval.candidate"]);
    expect(policy).not.toHaveBeenCalled();
    const clock =
      outcome === "timed-out"
        ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001)
        : undefined;
    try {
      await f.drive();
    } finally {
      clock?.mockRestore();
    }
    const events = f.events.slice(start);
    expect(events.at(-1)?.type).toBe("session.waiting");
    expect(events.filter((event) => event.type === "session.waiting")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.started")).toBe(false);
    expect(getApprovalAuditState(f.session.state).candidateHistory.at(-1)?.status).toBe(outcome);
    expect(f.pending()).toHaveLength(1);
    expect(f.executions).toEqual([]);

    allowed = true;
    f.script.push("Bob approved the task.");
    const retryStart = f.events.length;
    await f.drive(input);
    expect(f.pending()).toEqual([]);
    expect(f.executions).toEqual(["gateA"]);
    expect(
      f.events.slice(retryStart).filter((event) => event.type === "session.waiting"),
    ).toHaveLength(1);
  },
);

it("finishes a refusal while an unrelated task works, like an ordinary conversation turn", async () => {
  const f = fixture("refusal-with-working-task", () => ({
    status: "rejected",
    reason: "Bob must approve Alice's note.",
  }));
  await f.gate("gateA");
  // Bob's report keeps working; it is not this turn's work, so it holds nothing here.
  const report = createTaskRecord({
    creator: encodeTaskCreator({
      auth: {
        attributes: {},
        authenticator: "test",
        issuer: "test",
        principalId: "bob",
        principalType: "user",
      },
    }),
    id: "report-aaaaaa",
    mode: "detached",
    name: "report",
  });
  f.updateSession((session) => ({
    ...session,
    state: { ...session.state, ...taskTableState([report]) },
  }));
  const ordinaryStart = f.events.length;
  f.script.push("The report is still running.");
  await f.drive({ message: "What is the report's status?" });
  expect(f.events.slice(ordinaryStart).at(-1)?.type).toBe("session.waiting");

  const responseStart = f.events.length;
  await f.drive({
    attributedInputResponses: f.respond("gateA").inputResponses!.map((response) => ({
      response,
      auth: {
        attributes: {},
        authenticator: "test",
        issuer: "test",
        principalId: "alice",
        principalType: "user" as const,
      },
    })),
  });
  expect(f.events.slice(responseStart).map((event) => event.type)).toEqual([
    "approval.candidate",
    "approval.candidate",
    "session.waiting",
  ]);
  expect(f.pending()).toHaveLength(1);
  expect(f.executions).toEqual([]);
  expect(getTaskTable(f.session).records).toEqual([report]);
});

it("does not announce waiting while a candidate needs sign-in, then completes on expiry", async () => {
  const policy = vi.fn(() => ({ status: "allowed" as const }));
  const f = fixture("candidate-sign-in", policy);
  await f.gate("gateA");
  await f.step({
    attributedInputResponses: f.respond("gateA").inputResponses!.map((response) => ({
      response,
      auth: {
        attributes: {},
        authenticator: "test",
        issuer: "test",
        principalId: "alice",
        principalType: "user" as const,
      },
    })),
  });
  const candidate = getApprovalAuditState(f.session.state).activeCandidates[0]!;
  const challenges = [
    {
      candidateId: candidate.candidateId,
      name: "notes",
      hookUrl: "https://example.com/callback",
      challenge: { url: "https://example.com/sign-in" },
    },
  ];
  f.updateSession((session) => ({
    ...session,
    state: setPendingAuthorization(
      markApprovalCandidateAuthorizationRequired({
        state: session.state,
        candidateId: candidate.candidateId,
        authorizationChallenges: challenges,
      }),
      { challenges },
    ),
  }));
  const start = f.events.length;
  await f.drive();
  expect(f.events.slice(start)).toEqual([]);
  expect(policy).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, "now").mockReturnValue(candidate.expiresAt + 1);
  try {
    await f.drive();
  } finally {
    clock.mockRestore();
  }
  expect(f.events.slice(start).map((event) => event.type)).toEqual([
    "authorization.completed",
    "approval.candidate",
    "session.waiting",
  ]);
  expect(f.pending()).toHaveLength(1);
});

it("uses the normal turn boundary for a mixed accepted and refused delivery", async () => {
  const f = fixture("mixed-response", ({ request }) =>
    request.toolName === "gateA"
      ? { status: "allowed" }
      : { status: "rejected", reason: "Bob must approve this task." },
  );
  await f.gate("gateA");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Prepare Bob's independent task." });
  const start = f.events.length;
  f.script.push("Alice's task is complete.");
  await f.drive({
    attributedInputResponses: f.pending().map((request) => ({
      response: { requestId: request.requestId, optionId: "approve" },
      auth: {
        attributes: {},
        authenticator: "test",
        issuer: "test",
        principalId: "alice",
        principalType: "user" as const,
      },
    })),
  });
  expect(f.executions).toEqual(["gateA"]);
  expect(f.pending().map((request) => request.action.toolName)).toEqual(["gateB"]);
  expect(f.events.slice(start).filter((event) => event.type === "session.waiting")).toHaveLength(1);
});

it("resumes a complete batch while another batch has only a partial approval [control]", async () => {
  const f = fixture("complete-and-partial-approvals");
  // Given A and B need approval together, and a second independent B is pending.
  await f.gate("gateA", "gateB");
  const approvalA = f.respond("gateA");
  const approvalB = f.respond("gateB");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Prepare another independent B." });
  const independentB = f.pending().at(-1)!;
  const independentTurn = getPendingInputBatches(f.session.state)[1]!.event!.turnId;

  // When one delivery answers A and the independent B.
  f.script.push("Independent B approved.");
  const result = await f.drive({
    inputResponses: [
      ...approvalA.inputResponses!,
      { requestId: independentB.requestId, optionId: "approve" },
    ],
  });

  // Then only the complete batch executes and replies, without another model call.
  expect(result.settledTurn?.output).toBe("Independent B approved.");
  expect(f.restoredTurns).toEqual([independentTurn]);
  expect(f.executions).toEqual(["gateB"]);
  expect(f.pending()).toHaveLength(2);
  f.script.push("Both approved.");
  await f.drive(approvalB);
  expect(f.executions).toEqual(["gateB", "gateA", "gateB"]);
  expect(f.pending()).toHaveLength(0);
});
