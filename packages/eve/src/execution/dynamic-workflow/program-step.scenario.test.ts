import { describe, expect, it, vi } from "vitest";

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";
import type {
  WorkflowProgramCallResult,
  WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
import { runJsProgram } from "#execution/dynamic-workflow/workflow.js";

const continuationSecurity = {
  maxAgeMs: 60_000,
  signingKey: "workflow-program-scenario-test-signing-key",
};

function program(js: string, maxSubagents = 10): WorkflowProgramInput {
  return {
    continuationSecurity,
    js,
    maxSubagents,
  };
}

/** Resumes a parked program with one result per pending call, in pending order. */
function resume(
  outcome: Awaited<ReturnType<typeof runWorkflowProgramStep>>,
  values: readonly WorkflowProgramCallResult[],
) {
  if (outcome.status !== "interrupted") throw new Error("Expected pending agent calls.");
  return {
    continuation: outcome.continuation,
    resolutions: outcome.pending.map((pending, index) => ({
      interruptionId: pending.id,
      value: values[index]!,
    })),
  };
}

describe("workflow program sandbox", () => {
  it("converts the result as JSON.stringify does and reports syntax failures", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "pure",
        program: program("return { answer: 42, at: new Date(0), skipped: undefined };"),
      }),
    ).resolves.toEqual({
      output: { answer: 42, at: "1970-01-01T00:00:00.000Z" },
      status: "completed",
    });
    await expect(
      runWorkflowProgramStep({ callId: "no-return", program: program("const unused = 1;") }),
    ).resolves.toEqual({ output: null, status: "completed" });

    await expect(
      runWorkflowProgramStep({ callId: "syntax", program: program("return (") }),
    ).rejects.toThrow("unexpected token in expression: '}'");
  });

  it("measures values whose encoding run escapes six-fold by their JSON", async () => {
    // run encodes each `<` as `\u003C`; the quotes bring the JSON text to the limit.
    const atLimit = await runWorkflowProgramStep({
      callId: "escaped-result",
      program: program('return "<".repeat(1_048_574);'),
    });
    expect(atLimit.status === "completed" && (atLimit.output as string).length).toBe(1_048_574);
    await expect(
      runWorkflowProgramStep({
        callId: "escaped-result-over",
        program: program('return "<".repeat(1_048_575);'),
      }),
    ).rejects.toThrow(
      "Workflow program result is 1048577 bytes of JSON, over the 1048576 byte limit.",
    );

    // `{"target":"researcher","input":{"message":""}}` adds 46 bytes to the message.
    const parked = await runWorkflowProgramStep({
      callId: "escaped-input",
      program: program('return ctx.agent("researcher", { message: "<".repeat(1_048_530) });'),
    });
    expect(parked.status === "interrupted" && parked.pending[0]!.call.input.message.length).toBe(
      1_048_530,
    );
    await expect(
      runWorkflowProgramStep({
        callId: "escaped-input-over",
        program: program(`
try {
  return await ctx.agent("researcher", { message: "<".repeat(1_048_531) });
} catch (error) {
  return { code: error.code, message: error.message };
}`),
      }),
    ).resolves.toEqual({
      output: {
        code: "WORKFLOW_PROGRAM_AGENT_ERROR",
        message:
          "Workflow program ctx.agent() input is 1048577 bytes of JSON, over the 1048576 byte limit.",
      },
      status: "completed",
    });
  });

  it("resumes with a child reply of up to 4 MiB of JSON", async () => {
    // run encodes this 4 MiB of JSON as about 24 MiB.
    const reply = "<".repeat(4 * 1024 * 1024 - 2);
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
    ).resolves.toEqual({ output: reply.length, status: "completed" });
  });

  it("converts a shared-reference result to JSON inside the sandbox", async () => {
    // The sandbox holds 18 objects; the host only receives their 1.7 MB of JSON text.
    await expect(
      runWorkflowProgramStep({
        callId: "dag-result",
        program: program("let o = {}; for (let i = 0; i < 17; i++) o = { a: o, b: o }; return o;"),
      }),
    ).rejects.toThrow(
      "Workflow program result is 1703925 bytes of JSON, over the 1048576 byte limit.",
    );
  });

  it("rejects values that bypass the program prelude", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "bypass-result",
        program: program(`})) || { raw: true }; ((async () => {`),
      }),
    ).rejects.toThrow("Workflow program result must be JSON text.");
  });

  it("resumes a parallel batch together and then runs a dependent call", async () => {
    const input = program(`
const pair = await Promise.all([
  ctx.agent("researcher", { message: "alpha" }),
  ctx.agent("reviewer", { message: "beta" }),
]);
return ctx.agent("researcher", { message: pair.join("|") });`);
    const first = await runWorkflowProgramStep({ callId: "dependent", program: input });
    expect(first.status).toBe("interrupted");
    if (first.status !== "interrupted") throw new Error("Expected initial calls.");
    expect(first.pending.map((entry) => entry.call)).toEqual([
      { input: { message: "alpha" }, target: "researcher" },
      { input: { message: "beta" }, target: "reviewer" },
    ]);

    const second = await runWorkflowProgramStep({
      callId: "dependent",
      program: input,
      resume: resume(first, [
        { status: "completed", output: "A" },
        { status: "completed", output: "B" },
      ]),
    });
    expect(second.status).toBe("interrupted");
    if (second.status !== "interrupted") throw new Error("Expected dependent call.");
    expect(second.pending.map((entry) => entry.call)).toEqual([
      { input: { message: "A|B" }, target: "researcher" },
    ]);

    await expect(
      runWorkflowProgramStep({
        callId: "dependent",
        program: input,
        resume: resume(second, [{ status: "completed", output: { done: true } }]),
      }),
    ).resolves.toEqual({ output: { done: true }, status: "completed" });
  });

  it("fails a program that returns before every ctx.agent call settles", async () => {
    const input = program(`
return Promise.race([
  ctx.agent("researcher", { message: "a" }),
  ctx.agent("reviewer", { message: "b" }),
]);`);
    const first = await runWorkflowProgramStep({ callId: "race", program: input });
    // The losing call is still pending when the race settles on resume.
    await expect(
      runWorkflowProgramStep({
        callId: "race",
        program: input,
        resume: resume(first, [
          { status: "completed", output: "A" },
          { status: "completed", output: "B" },
        ]),
      }),
    ).rejects.toThrow(
      "Workflow program returned while a ctx.agent() call was still pending. Await every ctx.agent() call before returning, including calls passed to Promise.race or Promise.any.",
    );
  });

  it("lets generated code catch a failed child", async () => {
    const input = program(`
try {
  await ctx.agent("researcher", { message: "fail" });
  return "unexpected";
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`);
    const first = await runWorkflowProgramStep({ callId: "failure", program: input });

    await expect(
      runWorkflowProgramStep({
        callId: "failure",
        program: input,
        resume: resume(first, [{ status: "failed", error: "child failed" }]),
      }),
    ).resolves.toEqual({
      output: {
        code: "WORKFLOW_PROGRAM_AGENT_ERROR",
        message: "child failed",
        name: "WorkflowProgramAgentError",
      },
      status: "completed",
    });
  });

  it("lets generated code catch a malformed agent call without parking it", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "malformed",
        program: program(`
try {
  await ctx.agent("researcher", { prompt: "no message" });
  return "unexpected";
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`),
      }),
    ).resolves.toEqual({
      output: {
        code: "WORKFLOW_PROGRAM_AGENT_ERROR",
        message: 'Workflow program ctx.agent() requires a "message" string.',
        name: "WorkflowProgramAgentError",
      },
      status: "completed",
    });
  });

  it("enforces the total call budget through the real sandbox", async () => {
    const agent = vi.fn(() => ({
      send: async () => ({
        result: async () => ({ data: undefined, message: "ok", status: "waiting" }),
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
    ).rejects.toThrow("Workflow program source is 307210 bytes, over the 262144 byte limit.");

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
    ).rejects.toThrow("Continuation signature is invalid.");
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
    ).rejects.toThrow("Continuation signature is invalid.");
    await expect(
      runWorkflowProgramStep({ callId: "another-call", program: input, resume: valid }),
    ).rejects.toThrow(
      "Continuation does not match the supplied source, scope, or runtime version.",
    );
    await expect(
      runWorkflowProgramStep({ callId: "tamper", program: input, resume: valid }),
    ).resolves.toEqual({ output: "no", status: "completed" });
  });
});
