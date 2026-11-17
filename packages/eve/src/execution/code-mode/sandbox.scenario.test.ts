import { describe, expect, it } from "vitest";

import {
  ProgramCallError,
  runProgramSandbox,
  type ProgramSandboxInput,
  type ProgramSandboxOutcome,
} from "#execution/code-mode/sandbox.js";
import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";

// As eve's host does for agents with code mode on.
installWorkflowSandboxRuntime();

const security = { maxAgeMs: 60_000, signingKey: "program-sandbox-scenario-test-signing-key" };

/** Runs `code` with `call` answering its tools, recording each call the host was asked to run. */
function run(
  code: string,
  options: Partial<Pick<ProgramSandboxInput, "call" | "resume" | "search">> = {},
): Promise<ProgramSandboxOutcome> {
  return runProgramSandbox({
    call: async (_request, { input, name }) => ({ input: input as never, name }),
    callId: "call",
    code,
    search: async () => ({ results: [] }),
    security,
    ...options,
  });
}

describe("the program sandbox", () => {
  it("returns the program's value as JSON, with what it logged", async () => {
    await expect(
      run(`console.log("checked", { rows: 2 }); return { at: new Date(0), skipped: undefined };`),
    ).resolves.toEqual({
      logs: ['checked {"rows":2}'],
      result: { at: "1970-01-01T00:00:00.000Z" },
      status: "completed",
    });
  });

  it("numbers requests in program order and resolves each to its tool's output", async () => {
    const indexes: number[] = [];
    const outcome = await run(
      `const [a, b] = await Promise.all([tools.first({ n: 1 }), tools["second-tool"]()]); return [a, b];`,
      {
        call: async (request, { input, name }) => {
          indexes.push(request.index);
          return { input: input as never, name };
        },
      },
    );

    expect(indexes).toEqual([1, 2]);
    expect(outcome).toMatchObject({
      result: [
        { input: { n: 1 }, name: "first" },
        { input: {}, name: "second-tool" },
      ],
    });
  });

  it("lets the program catch a failed call, and reports an uncaught one with its line", async () => {
    const failing = {
      call: async () => {
        throw new ProgramCallError("The order was not found.");
      },
    };

    await expect(
      run(`try { await tools.lookup({}); } catch (error) { return error.message; }`, failing),
    ).resolves.toMatchObject({ result: "The order was not found.", status: "completed" });
    await expect(run(`const order = null;\nreturn order.id;`)).resolves.toEqual({
      error: "TypeError: cannot read property 'id' of null (line 2)",
      logs: [],
      status: "failed",
    });
  });

  it("parks on an interrupted call and resumes without running a recorded call again", async () => {
    const ran: string[] = [];
    const call: ProgramSandboxInput["call"] = async (request, { name }) => {
      if (request.resumed !== undefined) return request.resumed.resolution as never;
      ran.push(name);
      return name === "approve" ? request.interrupt() : name;
    };
    const code = `const a = await tools.lookup({}); const b = await tools.approve({}); return [a, b, await tools.finish({})];`;

    const parked = await run(code, { call });
    if (parked.status !== "interrupted") throw new Error("Expected the program to park.");
    expect(parked.pending).toEqual([{ index: 2, interruptionId: expect.any(String) }]);

    const resumed = await run(code, {
      call,
      resume: {
        continuation: parked.continuation,
        resolutions: [{ interruptionId: parked.pending[0]!.interruptionId, value: "approved" }],
      },
    });

    expect(resumed).toMatchObject({ result: ["lookup", "approved", "finish"] });
    // `lookup` ran once: the resume replayed its recorded result.
    expect(ran).toEqual(["lookup", "approve", "finish"]);
  });

  it("has no network, timers, or imports, and fails a program that leaves a call pending", async () => {
    await expect(
      run(`return [typeof fetch, typeof setTimeout, typeof require, typeof process];`),
    ).resolves.toMatchObject({ result: ["undefined", "undefined", "undefined", "undefined"] });
    await expect(
      run(`tools.slow({}); return 1;`, {
        call: async () => await new Promise((resolve) => setTimeout(() => resolve(1), 50)),
      }),
    ).resolves.toMatchObject({
      error: expect.stringContaining("returned while a tools call was still pending"),
      status: "failed",
    });
  });
});
