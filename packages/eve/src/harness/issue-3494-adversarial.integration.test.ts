import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { BackgroundToolExecutorKey } from "#harness/background-tools.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";

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
  responseAuthorized = false,
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
              ? { request: always(), response: async () => ({ status: "allowed" as const }) }
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
  tools.set("control", {
    name: "control",
    description: "Deferred runtime control",
    inputSchema: jsonSchema({ type: "object" }),
    runtimeAction: { kind: "task-control" },
  });
  tools.set("background", {
    name: "background",
    description: "Background workflow",
    inputSchema: jsonSchema({ type: "object" }),
    workflowId: "diagnostic-background",
    execution: "background",
    execute: async () => {
      throw new Error("Must dispatch through executor");
    },
  });
  const harness = createToolLoopHarness({
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
    ctx.set(BackgroundToolExecutorKey, {
      async execute({ batch, options }) {
        expect(batch.calls.some((call) => call.callId === options.toolCallId)).toBe(true);
        executions.push("background-admitted");
        return { status: "working", taskId: "diagnostic-background-task" };
      },
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
    executions,
    events,
    step,
    drive,
    get session() {
      return session;
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
        runtimeActionResults: [...batch.tasks, ...batch.runtimeActions].map((r) => ({
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

for (const tool of ["workflow", "control"]) {
  it(`interprets a completed ${tool} result while an earlier approval remains`, async () => {
    const f = fixture(tool);
    await f.gate("gateA");
    f.script.push(calls(tool), "FINAL");
    await f.drive({ message: `Run unrelated ${tool}.` });
    const result = await f.finishRuntime();
    expect(JSON.stringify(result.session.history)).toContain("runtime-RESULT");
    expect(f.pending()).toHaveLength(1);
    expect(result.settledTurn?.output).toBe("FINAL");
  });
}

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
  it(`continues after a background admission receipt ${pending ? "with pending approval" : "[control]"}`, async () => {
    const f = fixture(`background-${pending}`);
    if (pending) await f.gate("gateA");
    f.script.push(calls("background"), "FINAL");
    const result = await f.drive({ message: "Start background work and acknowledge admission." });
    expect(f.executions).toEqual(["background-admitted"]);
    expect(result.settledTurn?.output).toBe("FINAL");
  });
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

it("resumes a complete batch while another batch has only a partial approval [control]", async () => {
  const f = fixture("complete-and-partial-approvals");
  // Given A and B need approval together, and a second independent B is pending.
  await f.gate("gateA", "gateB");
  const approvalA = f.respond("gateA");
  const approvalB = f.respond("gateB");
  f.script.push(calls("gateB"));
  await f.drive({ message: "Prepare another independent B." });
  const independentB = f.pending().at(-1)!;

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
  expect(f.executions).toEqual(["gateB"]);
  expect(f.pending()).toHaveLength(2);
  f.script.push("Both approved.");
  await f.drive(approvalB);
  expect(f.executions).toEqual(["gateB", "gateA", "gateB"]);
  expect(f.pending()).toHaveLength(0);
});
