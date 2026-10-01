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
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { createTurnStartedEvent } from "#protocol/message.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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
      const parked = await drive({ message: `Prepare ${names.join(" and ")}.` });
      expect(parked.held).toEqual({ kind: "request" });
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

it("completes a plain tool turn without any pending input [control]", async () => {
  const f = fixture("control-no-pending");
  f.script.push(calls("read"), "FINAL");
  expect((await f.drive({ message: "Read the status." })).settledTurn?.output).toBe("FINAL");
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

it("runs the steering message after a budget grant that followed the cancelled approval", async () => {
  const f = fixture("steer-then-session-limit", false, 1);
  f.script.push(calls("gateA"));
  expect((await f.drive({ message: "Prepare gateA." })).held).toEqual({ kind: "request" });
  await f.drive({ message: "Read the status instead." });
  expect(f.pending().map((r) => r.kind)).toEqual(["session-limit"]);
  f.script.push(calls("read"), "FINAL");
  await f.drive(f.respond("session_limit_continuation", "continue"));
  // The message joined the step that cancelled the approval, so it reaches the
  // model once, without an extra model call spent before it.
  const userTexts = f.session.history
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content));
  expect(userTexts.filter((text) => text.includes("Read the status instead."))).toHaveLength(1);
  expect(
    f.events
      .filter((event) => event.type === "message.received")
      .map((event) => event.data.message),
  ).toEqual(["Prepare gateA.", "Read the status instead."]);
  expect(f.executions).toEqual(["read"]);
});

for (const variant of ["fail", "invalid"]) {
  it(`recovers from ${variant} without pending input [control]`, async () => {
    const logs = captureLogRecords();
    const f = fixture(`control-${variant}`);
    f.script.push(
      variant === "invalid" ? [{ toolName: "read", input: { n: "invalid" } }] : calls("fail"),
      "FINAL",
    );
    expect((await f.drive({ message: "Try the tool." })).settledTurn?.output).toBe("FINAL");
    if (variant === "invalid") expect(f.executions).toHaveLength(0);
    expect(
      logs.records.filter((record) => record.message === "tool execution failed"),
    ).toHaveLength(variant === "fail" ? 1 : 0);
  });
}

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

it("keeps a message waiting behind a budget prompt and runs it after the grant", async () => {
  const f = fixture("message-behind-session-limit", false, 1);
  f.script.push("Initial text.");
  await f.drive({ message: "Say hello." });
  await f.drive({ message: "Read the status." });
  expect(f.pending().map((r) => r.kind)).toEqual(["session-limit"]);

  const waitingStart = f.events.length;
  expect((await f.drive({ message: "Also say goodbye." })).held).toEqual({ kind: "request" });
  // The prompt still holds the turn; the message is announced when it runs.
  expect(f.events.slice(waitingStart).map((event) => event.type)).toEqual(["turn.waiting"]);
  expect(f.pending().map((r) => r.kind)).toEqual(["session-limit"]);

  f.script.push(calls("read"), "FINAL");
  await f.drive(f.respond("session_limit_continuation", "continue"));
  expect(f.executions).toEqual(["read"]);
  expect(
    f.events
      .filter((event) => event.type === "message.received")
      .map((event) => event.data.message),
  ).toEqual(["Say hello.", "Read the status.", "Also say goodbye."]);
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

it("cancels a held approval when the same person steers the turn", async () => {
  const f = fixture("steer-cancels-held-approval");
  f.script.push(calls("gateA"));
  const parked = await f.drive({ message: "Prepare gateA." });
  expect(parked.held).toEqual({ kind: "request" });
  f.script.push("FINAL", "FINAL");
  const result = await f.drive({ message: "Never mind, skip it." });
  expect(f.pending()).toHaveLength(0);
  expect(f.executions).toEqual([]);
  expect(f.events.filter((event) => event.type === "input.resolved")).toMatchObject([
    { data: { resolutions: [{ kind: "tool-approval", outcome: "ignored" }] } },
  ]);
  expect(f.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
  // The steering message replays after the cancelled call's result, and is announced once.
  expect(
    f.events
      .filter((event) => event.type === "message.received")
      .map((event) => event.data.message),
  ).toEqual(["Prepare gateA.", "Never mind, skip it."]);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it("runs an approved call and cancels the rest when a partial approval is steered", async () => {
  const f = fixture("steer-partial-approval");
  f.script.push(calls("gateA", "gateB"));
  const parked = await f.drive({ message: "Prepare gateA and gateB." });
  expect(parked.held).toEqual({ kind: "request" });
  const partialStart = f.events.length;
  const partial = await f.drive(f.respond("gateA"));
  // The partial answer leaves gateB open, so the turn stays held on it.
  expect(partial.held).toEqual({ kind: "request" });
  expect(f.events.slice(partialStart).map((event) => event.type)).toEqual(["turn.waiting"]);
  expect(f.executions).toEqual([]);
  expect(f.pending().map((request) => request.action.toolName)).toEqual(["gateA", "gateB"]);

  f.script.push("FINAL", "FINAL");
  const result = await f.drive({ message: "Skip gateB for now." });
  expect(f.executions).toEqual(["gateA"]);
  expect(f.pending()).toEqual([]);
  expect(
    f.events
      .filter((event) => event.type === "input.resolved")
      .flatMap((event) => event.data.resolutions)
      .map((resolution) => resolution.outcome),
  ).toEqual(["approved", "ignored"]);
  expect(result.settledTurn?.output).toBe("FINAL");
});

it.each(["rejected", "failed", "timed-out"] as const)(
  "keeps holding the turn after a %s response and resumes it on retry",
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
    let refused: StepResult;
    try {
      refused = await f.drive();
    } finally {
      clock?.mockRestore();
    }
    // The turn stays held, and `turn.waiting` gives the responder's send a boundary.
    const events = f.events.slice(start);
    expect(refused.held).toEqual({ kind: "request" });
    expect(events.at(-1)).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });
    expect(events.some((event) => event.type === "turn.started")).toBe(false);
    expect(getApprovalAuditState(f.session.state).candidateHistory.at(-1)?.status).toBe(outcome);
    expect(f.pending()).toHaveLength(1);
    expect(f.executions).toEqual([]);

    allowed = true;
    f.script.push("Bob approved the task.");
    const resumed = await f.drive(input);
    expect(f.pending()).toEqual([]);
    expect(f.executions).toEqual(["gateA"]);
    expect(resumed.settledTurn?.output).toBe("Bob approved the task.");
    expect(f.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
  },
);

it("keeps the turn held while a responder signs in, and fails the sign-in on expiry", async () => {
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
  expect((await f.drive()).held).toEqual({ kind: "request" });
  expect(f.events.slice(start).map((event) => event.type)).toEqual(["turn.waiting"]);
  expect(policy).not.toHaveBeenCalled();
  const expiry = f.events.length;
  const clock = vi.spyOn(Date, "now").mockReturnValue(candidate.expiresAt + 1);
  try {
    await f.drive();
  } finally {
    clock.mockRestore();
  }
  expect(f.events.slice(expiry)).toMatchObject([
    { data: { outcome: "failed" }, type: "authorization.completed" },
    { data: { outcome: "timed-out" }, type: "approval.candidate" },
    { data: { on: "input" }, type: "turn.waiting" },
  ]);
  expect(f.pending()).toHaveLength(1);
});

it("announces a candidate's sign-in with the attempt its completion will name", async () => {
  const f = fixture("candidate-sign-in-attempt", () => ({ status: "allowed" as const }));
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
  f.updateSession((session) => ({
    ...session,
    state: markApprovalCandidateAuthorizationRequired({
      state: session.state,
      candidateId: candidate.candidateId,
      authorizationChallenges: [
        {
          attemptId: "attempt_alice",
          candidateId: candidate.candidateId,
          name: "notes",
          hookUrl: "https://example.com/callback",
          challenge: { url: "https://example.com/sign-in" },
        },
      ],
    }),
  }));
  const start = f.events.length;
  await f.drive();
  expect(
    f.events.slice(start).find((event) => event.type === "authorization.required"),
  ).toMatchObject({
    data: { attemptId: "attempt_alice", candidateId: candidate.candidateId, name: "notes" },
  });
});
