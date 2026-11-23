import { describe, expect, it, vi } from "vitest";

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";
import type {
  WorkflowProgramAgents,
  WorkflowProgramCallResult,
  WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";
import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";

installWorkflowSandboxRuntime();

const continuationSecurity = {
  maxAgeMs: 60_000,
  signingKey: "workflow-program-scenario-test-signing-key",
};

function program(
  js: string,
  options: { readonly agents?: WorkflowProgramAgents; readonly maxSubagents?: number } = {},
): WorkflowProgramInput {
  return {
    agents: options.agents,
    continuationSecurity,
    js,
    maxSubagents: options.maxSubagents ?? 10,
  };
}

function resume(
  outcome: Awaited<ReturnType<typeof runWorkflowProgramStep>>,
  values: readonly WorkflowProgramCallResult[],
) {
  if (outcome.status !== "interrupted") throw new Error("Expected pending calls.");
  return {
    continuation: outcome.continuation,
    resolutions: outcome.pending.map((pending, index) => ({
      interruptionId: pending.id,
      value: values[index]!,
    })),
  };
}

describe("workflow program sandbox", () => {
  it("converts results as JSON.stringify does, captures console logs, and reports line numbers", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "pure",
        program: program(
          'console.log("step", { n: 1 }); console.warn("note"); return { answer: 42, at: new Date(0), skipped: undefined };',
        ),
      }),
    ).resolves.toEqual({
      logs: ['step {"n":1}', "note"],
      progress: [],
      result: { answer: 42, at: "1970-01-01T00:00:00.000Z" },
      status: "completed",
    });
    await expect(
      runWorkflowProgramStep({ callId: "no-return", program: program("const unused = 1;") }),
    ).resolves.toEqual({ logs: [], progress: [], result: null, status: "completed" });

    const syntax = await runWorkflowProgramStep({ callId: "syntax", program: program("return (") });
    expect(syntax.status).toBe("failed");
    if (syntax.status === "failed") {
      expect(syntax.error).toContain("unexpected token in expression: '}'");
    }

    const runtimeError = await runWorkflowProgramStep({
      callId: "line-number",
      program: program(
        ["const a = 1;", 'console.log("before boom");', 'throw new TypeError("boom");'].join("\n"),
        {
          agents: {
            researcher: { description: "Line one\nLine two\u2028Line three" },
          },
        },
      ),
    });
    expect(runtimeError).toEqual({
      error: "TypeError: boom (line 3)",
      logs: ["before boom"],
      progress: [],
      status: "failed",
    });
  });

  it("exposes frozen ctx.agents synchronously", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "agents-meta",
        program: program(
          "return { agents: ctx.agents, frozenMap: Object.isFrozen(ctx.agents), frozenEntry: Object.isFrozen(ctx.agents.researcher), frozenCtx: Object.isFrozen(ctx) };",
          {
            agents: {
              researcher: { description: "Investigate topics" },
            },
          },
        ),
      }),
    ).resolves.toEqual({
      logs: [],
      progress: [],
      result: {
        agents: { researcher: { description: "Investigate topics" } },
        frozenCtx: true,
        frozenEntry: true,
        frozenMap: true,
      },
      status: "completed",
    });
  });

  it("caps console output at 64 KiB", async () => {
    const outcome = await runWorkflowProgramStep({
      callId: "console-cap",
      program: program('for (let i = 0; i < 100; i++) console.log("x".repeat(1000)); return "ok";'),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.result).toBe("ok");
      expect(outcome.logs.at(-1)).toBe("(console output truncated)");
      expect(outcome.logs.length).toBeLessThan(100);
    }
  });

  it("measures values whose encoding run escapes six-fold by their JSON", async () => {
    const atLimit = await runWorkflowProgramStep({
      callId: "escaped-result",
      program: program('return "<".repeat(1_048_574);'),
    });
    expect(atLimit.status === "completed" && (atLimit.result as string).length).toBe(1_048_574);
    const overLimit = await runWorkflowProgramStep({
      callId: "escaped-result-over",
      program: program('return "<".repeat(1_048_575);'),
    });
    expect(overLimit).toEqual({
      error:
        "EXECUTE_VALUE_TOO_LARGE: the program's result is 1048577 bytes of JSON, over the 1048576 byte limit.",
      logs: [],
      progress: [],
      status: "failed",
    });

    const parked = await runWorkflowProgramStep({
      callId: "escaped-input",
      program: program('return ctx.agent("researcher", { message: "<".repeat(500_000) });'),
    });
    expect(
      parked.status === "interrupted" &&
        parked.pending[0]!.action.kind === "agent" &&
        parked.pending[0]!.action.input.message.length,
    ).toBe(500_000);
    await expect(
      runWorkflowProgramStep({
        callId: "escaped-input-over",
        program: program(`
try {
  return await ctx.agent("researcher", { message: "<".repeat(1_048_531) });
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`),
      }),
    ).resolves.toEqual({
      logs: [],
      progress: [],
      result: {
        code: "WORKFLOW_PROGRAM_AGENT_ERROR",
        message:
          "EXECUTE_VALUE_TOO_LARGE: the program's ctx.agent() input is 1048577 bytes of JSON, over the 1048576 byte limit.",
        name: "WorkflowProgramAgentError",
      },
      status: "completed",
    });
  });

  it("resumes with a 4 MiB child reply and enforces the 8 MiB continuation cap", async () => {
    const reply = "a".repeat(4 * 1024 * 1024 - 2);
    const input = program(
      'const reply = await ctx.agent("researcher", { message: "m" }); return reply.length;',
    );
    const first = await runWorkflowProgramStep({ callId: "large-reply", program: input });
    await expect(
      runWorkflowProgramStep({
        callId: "large-reply",
        program: input,
        resume: resume(first, [{ status: "completed", output: reply }]),
      }),
    ).resolves.toEqual({ logs: [], progress: [], result: reply.length, status: "completed" });

    const overContinuation = await runWorkflowProgramStep({
      callId: "large-reply",
      program: input,
      resume: resume(first, [{ status: "completed", output: "<".repeat(4 * 1024 * 1024 - 2) }]),
    });
    expect(overContinuation).toEqual({
      error:
        "EXECUTE_CONTINUATION_LIMIT_REACHED: the results the program holds while it waits are over 8 MiB. Return less from each call, or make fewer calls per program.",
      logs: [],
      progress: [],
      status: "failed",
    });
  });

  it("converts a shared-reference result to JSON inside the sandbox and rejects prelude bypass", async () => {
    const dag = await runWorkflowProgramStep({
      callId: "dag-result",
      program: program("let o = {}; for (let i = 0; i < 17; i++) o = { a: o, b: o }; return o;"),
    });
    expect(dag.status).toBe("failed");
    if (dag.status === "failed") {
      expect(dag.error).toContain("EXECUTE_VALUE_TOO_LARGE");
    }

    const bypass = await runWorkflowProgramStep({
      callId: "bypass-result",
      program: program(`})(); return { raw: true }; } catch {} try { (async () => {`),
    });
    expect(bypass).toEqual({
      error: "The program's result must be JSON text.",
      logs: [],
      progress: [],
      status: "failed",
    });
  });

  it("round-trips ctx.progress, ctx.ask, ctx.sleep, and ctx.agent without replaying prior progress", async () => {
    const input = program(`
await ctx.progress({ stage: "start" });
const [answer, slept] = await Promise.all([
  ctx.ask({ prompt: "Continue?", display: "confirmation", options: [{ id: "yes", label: "Yes" }] }),
  ctx.sleep(5),
]);
await ctx.progress({ stage: "after-wait" });
const reply = await ctx.agent("researcher", { message: answer.optionId + ":" + slept.waitedSeconds });
await ctx.progress({ stage: "done" });
return reply;`);

    const first = await runWorkflowProgramStep({ callId: "capabilities", program: input });
    expect(first.status).toBe("interrupted");
    if (first.status !== "interrupted") throw new Error("Expected ask + sleep batch.");
    expect(first.progress).toEqual([{ stage: "start" }]);
    expect(first.pending.map((entry) => entry.action)).toEqual([
      {
        kind: "ask",
        request: {
          display: "confirmation",
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Continue?",
        },
      },
      { kind: "sleep", seconds: 5 },
    ]);

    const second = await runWorkflowProgramStep({
      callId: "capabilities",
      program: input,
      resume: resume(first, [
        { output: { optionId: "yes", status: "answered" }, status: "completed" },
        { output: { waitedSeconds: 5 }, status: "completed" },
      ]),
    });
    expect(second.status).toBe("interrupted");
    if (second.status !== "interrupted") throw new Error("Expected agent call.");
    expect(second.progress).toEqual([{ stage: "after-wait" }]);
    expect(second.pending.map((entry) => entry.action)).toEqual([
      { input: { message: "yes:5" }, kind: "agent", target: "researcher" },
    ]);

    await expect(
      runWorkflowProgramStep({
        callId: "capabilities",
        program: input,
        resume: resume(second, [{ output: { ok: true }, status: "completed" }]),
      }),
    ).resolves.toEqual({
      logs: [],
      progress: [{ stage: "done" }],
      result: { ok: true },
      status: "completed",
    });
  });

  it("fails a program that returns before every pending call settles", async () => {
    const input = program(`
return Promise.race([
  ctx.agent("researcher", { message: "a" }),
  ctx.agent("reviewer", { message: "b" }),
]);`);
    const first = await runWorkflowProgramStep({ callId: "race", program: input });
    await expect(
      runWorkflowProgramStep({
        callId: "race",
        program: input,
        resume: resume(first, [
          { status: "completed", output: "A" },
          { status: "completed", output: "B" },
        ]),
      }),
    ).resolves.toEqual({
      error:
        "The program returned while a call was still pending. Await every call before returning, including calls passed to Promise.race or Promise.any.",
      logs: [],
      progress: [],
      status: "failed",
    });
  });

  it("lets generated code catch failed or malformed bridge calls", async () => {
    const failedChild = program(`
try {
  await ctx.agent("researcher", { message: "fail" });
  return "unexpected";
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`);
    const first = await runWorkflowProgramStep({ callId: "failure", program: failedChild });
    await expect(
      runWorkflowProgramStep({
        callId: "failure",
        program: failedChild,
        resume: resume(first, [{ status: "failed", error: "child failed" }]),
      }),
    ).resolves.toEqual({
      logs: [],
      progress: [],
      result: {
        code: "WORKFLOW_PROGRAM_AGENT_ERROR",
        message: "child failed",
        name: "WorkflowProgramAgentError",
      },
      status: "completed",
    });

    await expect(
      runWorkflowProgramStep({
        callId: "malformed",
        program: program(`
const errors = [];
for (const fn of [
  () => ctx.agent("researcher", { prompt: "no message" }),
  () => ctx.ask({ prompt: "" }),
  () => ctx.sleep(0),
  () => ctx.progress(undefined),
]) {
  try {
    await fn();
  } catch (error) {
    errors.push({ code: error.code, message: error.message, name: error.name });
  }
}
return errors;`),
      }),
    ).resolves.toEqual({
      logs: [],
      progress: [],
      result: [
        {
          code: "WORKFLOW_PROGRAM_AGENT_ERROR",
          message: 'Workflow program ctx.agent() requires a "message" string.',
          name: "WorkflowProgramAgentError",
        },
        {
          code: "WORKFLOW_PROGRAM_ERROR",
          message: 'Workflow program ctx.ask() requires a non-empty "prompt" string.',
          name: "WorkflowProgramError",
        },
        {
          code: "WORKFLOW_PROGRAM_ERROR",
          message:
            "Workflow program ctx.sleep() requires a finite number of seconds greater than 0 and at most 31536000.",
          name: "WorkflowProgramError",
        },
        {
          code: "WORKFLOW_PROGRAM_ERROR",
          message: "Workflow program ctx.progress() requires a JSON-serializable update value.",
          name: "WorkflowProgramError",
        },
      ],
      status: "completed",
    });
  });

  it("enforces the total call budget through the real sandbox", async () => {
    const agent = vi.fn(() => ({
      send: async () => ({
        result: async () => ({ data: undefined, reply: "ok", status: "completed" }),
      }),
    }));
    const ctx = { abortSignal: new AbortController().signal, agent, callId: "policy" } as never;
    const js = `
await ctx.agent("researcher", { message: "one" });
try {
  await ctx.agent("researcher", { message: "two" });
  return "unexpected";
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`;

    await expect(runJsProgram(js, ctx, { maxSubagents: 1 })).resolves.toEqual({
      code: "WORKFLOW_PROGRAM_AGENT_ERROR",
      message:
        'WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most 1 agents; "researcher" was not called.',
      name: "WorkflowProgramAgentError",
    });
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized source and tampered continuations", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "large",
        program: program(`return ${JSON.stringify("x".repeat(300 * 1024))};`),
      }),
    ).resolves.toEqual({
      error: "EXECUTE_SOURCE_TOO_LARGE: the program is 307210 bytes, over the 262144 byte limit.",
      logs: [],
      progress: [],
      status: "failed",
    });

    const input = program('return ctx.agent("researcher", { message: "x" });');
    const first = await runWorkflowProgramStep({ callId: "tamper", program: input });
    const valid = resume(first, [{ status: "completed", output: "no" }]);
    const middle = Math.floor(valid.continuation.length / 2);
    const flipped = valid.continuation[middle] === "A" ? "B" : "A";
    const tampered = `${valid.continuation.slice(0, middle)}${flipped}${valid.continuation.slice(middle + 1)}`;

    await expect(
      runWorkflowProgramStep({
        callId: "tamper",
        program: input,
        resume: { ...valid, continuation: tampered },
      }),
    ).resolves.toMatchObject({ error: "Continuation signature is invalid.", status: "failed" });
    await expect(
      runWorkflowProgramStep({
        callId: "tamper",
        program: {
          ...input,
          continuationSecurity: {
            ...continuationSecurity,
            signingKey: "another-workflow-program-signing-key",
          },
        },
        resume: valid,
      }),
    ).resolves.toMatchObject({ error: "Continuation signature is invalid.", status: "failed" });
    await expect(
      runWorkflowProgramStep({ callId: "another-call", program: input, resume: valid }),
    ).resolves.toMatchObject({
      error: "Continuation does not match the supplied source, scope, or runtime version.",
      status: "failed",
    });
    await expect(
      runWorkflowProgramStep({ callId: "tamper", program: input, resume: valid }),
    ).resolves.toEqual({ logs: [], progress: [], result: "no", status: "completed" });
  });
});
