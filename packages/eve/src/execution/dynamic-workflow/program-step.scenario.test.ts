import { describe, expect, it, vi } from "vitest";

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";
import {
  readWorkflowProgramAgentCall,
  readWorkflowProgramCallInterrupt,
  type WorkflowProgramInput,
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

describe("workflow program sandbox", () => {
  it("returns pure JSON and reports syntax failures", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "pure",
        program: program('return { answer: 42, nested: ["ok"] };'),
      }),
    ).resolves.toEqual({
      output: { answer: 42, nested: ["ok"] },
      status: "completed",
    });

    await expect(
      runWorkflowProgramStep({ callId: "syntax", program: program("return (") }),
    ).rejects.toThrow();
  });

  it("continues parallel calls in request order and then runs a dependent call", async () => {
    const input = program(`
const pair = await Promise.all([
  ctx.agent("researcher", { message: "alpha" }),
  ctx.agent("reviewer", { message: "beta" }),
]);
return ctx.agent("researcher", { message: pair.join("|") });`);
    const first = await runWorkflowProgramStep({ callId: "dependent", program: input });
    expect(first.status).toBe("interrupted");
    if (first.status !== "interrupted") throw new Error("Expected initial calls.");
    expect(
      first.pending.map((entry) =>
        readWorkflowProgramAgentCall(readWorkflowProgramCallInterrupt(entry).toolInput),
      ),
    ).toEqual([
      { input: { message: "alpha" }, target: "researcher" },
      { input: { message: "beta" }, target: "reviewer" },
    ]);

    const second = await runWorkflowProgramStep({
      callId: "dependent",
      program: input,
      resume: {
        interrupt: first.interrupt,
        resolutions: [
          { status: "completed", output: "A" },
          { status: "completed", output: "B" },
        ],
      },
    });
    expect(second.status).toBe("interrupted");
    if (second.status !== "interrupted") throw new Error("Expected dependent call.");
    expect(
      readWorkflowProgramAgentCall(readWorkflowProgramCallInterrupt(second.pending[0]!).toolInput),
    ).toEqual({ input: { message: "A|B" }, target: "researcher" });

    await expect(
      runWorkflowProgramStep({
        callId: "dependent",
        program: input,
        resume: {
          interrupt: second.interrupt,
          resolutions: [{ status: "completed", output: { done: true } }],
        },
      }),
    ).resolves.toEqual({ output: { done: true }, status: "completed" });
  });

  it("lets generated code catch a failed child", async () => {
    const input = program(`
try {
  await ctx.agent("researcher", { message: "fail" });
  return "unexpected";
} catch (error) {
  return { caught: error.message };
}`);
    const first = await runWorkflowProgramStep({ callId: "failure", program: input });
    if (first.status !== "interrupted") throw new Error("Expected agent call.");

    await expect(
      runWorkflowProgramStep({
        callId: "failure",
        program: input,
        resume: {
          interrupt: first.interrupt,
          resolutions: [{ status: "failed", error: "child failed" }],
        },
      }),
    ).resolves.toEqual({ output: { caught: "child failed" }, status: "completed" });
  });

  it("enforces the total call budget through the real sandbox", async () => {
    const agent = vi.fn(() => ({
      send: async () => ({
        result: async () => ({ data: undefined, message: "ok", status: "waiting" }),
      }),
    }));
    const ctx = {
      abortSignal: new AbortController().signal,
      agent,
      callId: "policy",
    } as never;

    await expect(
      runJsProgram(
        `
try {
  await ctx.agent("researcher", { message: "one" });
  await ctx.agent("researcher", { message: "two" });
  return "unexpected";
} catch (error) {
  return error.message;
}`,
        ctx,
        { maxSubagents: 1 },
      ),
    ).resolves.toContain("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED");
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized source and tampered continuations", async () => {
    await expect(
      runWorkflowProgramStep({
        callId: "large",
        program: program(`return ${JSON.stringify("x".repeat(300 * 1024))};`),
      }),
    ).rejects.toThrow(/source|large|bytes/i);

    const input = program('return ctx.agent("researcher", { message: "x" });');
    const first = await runWorkflowProgramStep({ callId: "tamper", program: input });
    if (first.status !== "interrupted") throw new Error("Expected agent call.");
    const tampered = structuredClone(first.interrupt);
    tampered.continuation.auth.signature = `${tampered.continuation.auth.signature}x`;

    await expect(
      runWorkflowProgramStep({
        callId: "tamper",
        program: input,
        resume: {
          interrupt: tampered,
          resolutions: [{ status: "completed", output: "no" }],
        },
      }),
    ).rejects.toThrow();
  });
});
