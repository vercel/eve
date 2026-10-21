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

/** Builds a value whose JSON text doubles with each level while run transfers it compactly. */
const sharedReferenceDag = (depth: number) =>
  `let o = {}; for (let i = 0; i < ${String(depth)}; i++) o = { a: o, b: o };`;

describe("workflow program sandbox", () => {
  it("converts the result as JSON.stringify does and reports syntax failures", async () => {
    // Expected values match what @ai-sdk/code-mode returned for the same programs.
    await expect(
      runWorkflowProgramStep({
        callId: "pure",
        program: program(`
class Point { constructor() { this.x = 1; } move() {} }
return {
  answer: 42,
  nested: ["ok", undefined, () => 1, Symbol("s")],
  at: new Date(0),
  skipped: undefined,
  method: { a: 1, f() {} },
  instance: new Point(),
  custom: { toJSON() { return "custom"; } },
  symbol: { s: Symbol("s") },
  promise: { p: Promise.resolve(1) },
};`),
      }),
    ).resolves.toEqual({
      output: {
        answer: 42,
        at: "1970-01-01T00:00:00.000Z",
        custom: "custom",
        instance: { x: 1 },
        method: { a: 1 },
        nested: ["ok", null, null, null],
        promise: { p: {} },
        symbol: {},
      },
      status: "completed",
    });
    await expect(
      runWorkflowProgramStep({ callId: "no-return", program: program("const unused = 1;") }),
    ).resolves.toEqual({ output: null, status: "completed" });

    await expect(
      runWorkflowProgramStep({ callId: "syntax", program: program("return (") }),
    ).rejects.toThrow("unexpected token in expression: '}'");
  });

  it("applies the 1 MiB result limit to JSON text", async () => {
    // Quotes are a third of this JSON, and run's encoding escapes each one.
    const underLimit = await runWorkflowProgramStep({
      callId: "quotes",
      program: program('return Array(300_000).fill("");'),
    });
    expect(underLimit.status === "completed" && (underLimit.output as unknown[]).length).toBe(
      300_000,
    );

    await expect(
      runWorkflowProgramStep({
        callId: "too-large",
        program: program('return Array(400_000).fill("");'),
      }),
    ).rejects.toThrow(
      "Workflow program result is 1200001 bytes of JSON, over the 1048576 byte limit.",
    );
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
        code: "WORKFLOW_PROGRAM_INVALID_AGENT_CALL",
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
        program: program(`${sharedReferenceDag(17)} return o;`),
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
    await expect(
      runWorkflowProgramStep({
        callId: "bypass-agent",
        program: program(`
try {
  await __eveWorkflowProgram.agent({ target: "researcher", input: { message: "x" } });
} catch (error) {
  return error.message;
}`),
      }),
    ).resolves.toEqual({
      output: "Workflow program ctx.agent() input must be JSON text.",
      status: "completed",
    });
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
    const pendingMessage =
      "Workflow program returned while a ctx.agent() call was still pending. Await every ctx.agent() call before returning, including calls passed to Promise.race or Promise.any.";
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
    ).rejects.toThrow(pendingMessage);

    await expect(
      runWorkflowProgramStep({
        callId: "detached",
        program: program('ctx.agent("researcher", { message: "a" }); return "done";'),
      }),
    ).rejects.toThrow(pendingMessage);
  });

  it("lets generated code catch a failed child, including on later replays", async () => {
    const input = program(`
let caught;
try {
  await ctx.agent("researcher", { message: "fail" });
} catch (error) {
  caught = { code: error.code, message: error.message, name: error.name };
}
return { caught, next: await ctx.agent("reviewer", { message: caught.message }) };`);
    const first = await runWorkflowProgramStep({ callId: "failure", program: input });
    const second = await runWorkflowProgramStep({
      callId: "failure",
      program: input,
      resume: resume(first, [{ status: "failed", error: "child failed" }]),
    });
    expect(second.status === "interrupted" && second.pending.map((entry) => entry.call)).toEqual([
      { input: { message: "child failed" }, target: "reviewer" },
    ]);

    await expect(
      runWorkflowProgramStep({
        callId: "failure",
        program: input,
        resume: resume(second, [{ status: "completed", output: "reviewed" }]),
      }),
    ).resolves.toEqual({
      output: {
        caught: {
          code: "WORKFLOW_PROGRAM_AGENT_FAILED",
          message: "child failed",
          name: "WorkflowProgramAgentError",
        },
        next: "reviewed",
      },
      status: "completed",
    });
  });

  it("lets generated code catch a malformed agent call without parking it", async () => {
    const catchCall = (call: string) => `
try {
  await ${call};
  return "unexpected";
} catch (error) {
  return { code: error.code, frozen: Object.isFrozen(ctx), message: error.message, name: error.name };
}`;
    const rejected = (message: string) => ({
      output: {
        code: "WORKFLOW_PROGRAM_INVALID_AGENT_CALL",
        frozen: true,
        message,
        name: "WorkflowProgramAgentCallError",
      },
      status: "completed",
    });

    await expect(
      runWorkflowProgramStep({
        callId: "malformed",
        program: program(catchCall('ctx.agent("researcher", { prompt: "no message" })')),
      }),
    ).resolves.toEqual(rejected('Workflow program ctx.agent() requires a "message" string.'));
    await expect(
      runWorkflowProgramStep({
        callId: "oversized",
        program: program(catchCall('ctx.agent("researcher", { message: "x".repeat(1_200_000) })')),
      }),
    ).resolves.toEqual(
      rejected(
        "Workflow program ctx.agent() input is 1200046 bytes of JSON, over the 1048576 byte limit.",
      ),
    );
  });

  it("converts a shared-reference agent input to JSON inside the sandbox", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "dag-input",
        program: program(`${sharedReferenceDag(17)}
try {
  return await ctx.agent("researcher", { message: "m", outputSchema: o });
} catch (error) {
  return error.message;
}`),
      }),
    ).resolves.toEqual({
      output:
        "Workflow program ctx.agent() input is 1703988 bytes of JSON, over the 1048576 byte limit.",
      status: "completed",
    });
  });

  /** A workflow context whose children reply to the message they receive with `reply`. */
  const replyingCtx = (callId: string, reply: (message: string) => string) => {
    const agent = vi.fn(() => ({
      send: async (message: string) => ({
        result: async () => ({ data: undefined, message: reply(message), status: "waiting" }),
      }),
    }));
    return { agent, ctx: { abortSignal: new AbortController().signal, agent, callId } as never };
  };
  const catchSecondCall = `
await ctx.agent("researcher", { message: "one" });
try {
  await ctx.agent("researcher", { message: "two" });
  return "unexpected";
} catch (error) {
  return { code: error.code, message: error.message, name: error.name };
}`;

  it("enforces the total call budget through the real sandbox", async () => {
    const { agent, ctx } = replyingCtx("policy", () => "ok");

    await expect(runJsProgram(catchSecondCall, ctx, { maxSubagents: 1 })).resolves.toEqual({
      code: "WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED",
      message:
        'WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most 1 agents; "researcher" was not called.',
      name: "WorkflowProgramSubagentLimitError",
    });
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it("lets generated code catch a child reply over 4 MiB of JSON", async () => {
    // With its quotes, the second reply is 4 MiB + 1 byte of JSON.
    const { agent, ctx } = replyingCtx("large-reply", (message) =>
      message === "one" ? "ok" : "<".repeat(4 * 1024 * 1024 - 1),
    );

    await expect(runJsProgram(catchSecondCall, ctx, { maxSubagents: 2 })).resolves.toEqual({
      code: "WORKFLOW_PROGRAM_AGENT_FAILED",
      message:
        'Agent "researcher" replied with 4194305 bytes of JSON, over the 4194304 byte limit for a ctx.agent() result.',
      name: "WorkflowProgramAgentError",
    });
    expect(agent).toHaveBeenCalledTimes(2);
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
          continuationSecurity: { ...continuationSecurity, signingKey: "another-signing-key" },
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
