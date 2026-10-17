import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptProgramRuntime } from "./javascript.js";
import type { ProgramStart, ProgramStep } from "./runtime.js";

const runtime = new JavaScriptProgramRuntime();
afterEach(() => runtime.close());
function input(source: string, overrides: Partial<ProgramStart["limits"]> = {}): ProgramStart {
  return {
    source,
    toolNames: ["read", "write"],
    limits: {
      deadlineAt: Date.now() + 30_000,
      maxInFlightCalls: 32,
      maxTotalCalls: 256,
      memoryBytes: 64 * 1024 * 1024,
      ...overrides,
    },
  };
}
function parked(step: ProgramStep) {
  expect(step.timing!.startupMs).toBeGreaterThanOrEqual(0);
  expect(step.timing!.runMs).toBeGreaterThanOrEqual(0);
  expect(step.status).toBe("parked");
  if (step.status !== "parked") throw new Error(JSON.stringify(step));
  return step;
}

describe("JavaScriptProgramRuntime (real QuickJS)", () => {
  it("returns JSON and captured logs", async () => {
    expect(await runtime.start(input('console.log("hello"); return { ok: true };'))).toEqual({
      timing: { startupMs: expect.any(Number), runMs: expect.any(Number) },
      status: "completed",
      output: { ok: true },
      logs: ["hello"],
    });
  });

  it("parks a concurrent batch, resumes, then parks the next sequential call", async () => {
    const program = input(
      "const values = await Promise.all([tools.read({ n: 1 }), tools.read({ n: 2 })]); return await tools.write(values);",
    );
    const first = parked(await runtime.start(program));
    expect(first.calls).toEqual([
      { index: 0, tool: "read", input: { n: 1 } },
      { index: 1, tool: "read", input: { n: 2 } },
    ]);
    const results = [
      { index: 0, status: "completed" as const, output: "one" },
      { index: 1, status: "completed" as const, output: "two" },
    ];
    const next = parked(await runtime.resume({ ...program, state: first.state, results }));
    expect(first.timing!.startupMs).toBeGreaterThanOrEqual(0);
    expect(first.timing!.runMs).toBeGreaterThanOrEqual(0);
    expect(next.timing!.startupMs).toBe(0);
    expect(next.timing!.runMs).toBeGreaterThanOrEqual(0);
    expect(next.calls).toEqual([{ index: 2, tool: "write", input: ["one", "two"] }]);
    expect(
      await runtime.resume({
        ...program,
        state: next.state,
        results: [...results, { index: 2, status: "completed", output: "saved" }],
      }),
    ).toEqual({
      timing: { startupMs: expect.any(Number), runMs: expect.any(Number) },
      status: "completed",
      output: "saved",
      logs: [],
    });
    // Resuming the same recorded continuation replays interpreter work, not a tool.
    expect(parked(await runtime.resume({ ...program, state: first.state, results })).calls).toEqual(
      next.calls,
    );
  });

  it("retains guest-local values and console history instead of rerunning the prefix on a cache hit", async () => {
    const program = input(
      'const marker = Math.random(); console.log("prefix", marker); await tools.read(marker); return await tools.write(marker);',
    );
    const first = parked(await runtime.start(program));
    const marker = first.calls[0]!.input;
    const results = [{ index: 0, status: "completed" as const, output: null }];
    const next = parked(await runtime.resume({ ...program, state: first.state, results }));
    expect(next.calls).toEqual([{ index: 1, tool: "write", input: marker }]);
    expect(
      await runtime.resume({
        ...program,
        state: next.state,
        results: [...results, { index: 1, status: "completed", output: "done" }],
      }),
    ).toEqual({
      timing: { startupMs: 0, runMs: expect.any(Number) },
      status: "completed",
      output: "done",
      logs: [`prefix ${marker}`],
    });
  });

  it("parks the full 32-call frontier without checkpoint overhead reducing the call cap", async () => {
    const program = input(
      "return await Promise.all(Array.from({ length: 32 }, (_, n) => tools.read({ n })));",
    );
    const first = parked(await runtime.start(program));
    expect(first.calls).toHaveLength(32);
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: first.calls.map((call) => ({
          index: call.index,
          status: "completed" as const,
          output: call.index,
        })),
      }),
    ).toMatchObject({ status: "completed", output: Array.from({ length: 32 }, (_, n) => n) });
  });

  it("reports unknown outcomes without asking the host to call again", async () => {
    const program = input('console.log("before"); await tools.write({ value: 1 }); return true;');
    const first = parked(await runtime.start(program));
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "unknown", error: "worker crashed" }],
      }),
    ).toEqual({
      timing: { startupMs: expect.any(Number), runMs: expect.any(Number) },
      status: "failed",
      errorClass: "runtime",
      logs: ["before"],
      error: expect.stringContaining("side effect may or may not have happened"),
    });
  });

  it("reconstructs a lost interpreter from recorded results without reissuing completed calls", async () => {
    const program = input(
      "const first = await tools.read({ n: 1 }); const second = await tools.write(first); return second;",
    );
    const first = parked(await runtime.start(program));
    runtime.close();
    const restarted = new JavaScriptProgramRuntime();
    try {
      const next = parked(
        await restarted.resume({
          ...program,
          state: JSON.parse(JSON.stringify(first.state)),
          results: [{ index: 0, status: "completed", output: "recorded" }],
        }),
      );
      expect(next.calls).toEqual([{ index: 1, tool: "write", input: "recorded" }]);
      expect(
        await restarted.resume({
          ...program,
          state: next.state,
          results: [
            { index: 0, status: "completed", output: "recorded" },
            { index: 1, status: "completed", output: "done" },
          ],
        }),
      ).toMatchObject({ status: "completed", output: "done" });
    } finally {
      restarted.close();
    }
  });

  it("enforces total and in-flight call caps", async () => {
    const program = input("await tools.read(null); return await tools.read(null);", {
      maxTotalCalls: 1,
    });
    const first = parked(await runtime.start(program));
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "completed", output: null }],
      }),
    ).toMatchObject({ status: "failed", errorClass: "call-limit" });
    expect(
      await runtime.start(
        input("return await Promise.all([tools.read(null), tools.read(null)]);", {
          maxInFlightCalls: 1,
        }),
      ),
    ).toMatchObject({ status: "failed", errorClass: "call-limit" });
  });

  it("does not allow raw bridge access to reuse a recorded call index", async () => {
    const program = input(
      'await tools.read(null); return await __host.call({ index: 0, tool: "read", input: null, logs: [] });',
    );
    const first = parked(await runtime.start(program));
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "completed", output: null }],
      }),
    ).toMatchObject({ status: "failed", errorClass: "call-limit" });
  });

  it("enforces a hard deadline even for a busy loop", async () => {
    expect(
      await runtime.start(input("for (;;) {}", { deadlineAt: Date.now() + 100 })),
    ).toMatchObject({ status: "failed", errorClass: "deadline" });
    expect(await runtime.start(input("return 1;", { deadlineAt: 0 }))).toMatchObject({
      status: "failed",
      errorClass: "deadline",
    });
  });

  it("preserves bounded console logs on program errors and rejects unknown tools", async () => {
    const result = await runtime.start(
      input('console.error("failure context"); throw new Error("broken");'),
    );
    expect(result.timing!.startupMs).toBeGreaterThanOrEqual(0);
    expect(result.timing!.runMs).toBeGreaterThanOrEqual(0);
    expect(result).toEqual({
      timing: { startupMs: expect.any(Number), runMs: expect.any(Number) },
      status: "failed",
      error: "broken",
      errorClass: "runtime",
      logs: ["failure context"],
    });
    expect(await runtime.start(input("return await tools.missing({});"))).toMatchObject({
      status: "failed",
      errorClass: "unknown-tool",
    });
    const capped = await runtime.start(
      input('console.log("x".repeat(100000)); throw new Error("broken");'),
    );
    expect(capped.status).toBe("failed");
    if (capped.status === "failed")
      expect(capped.logs.join("\n").length).toBeLessThanOrEqual(16 * 1024);
  });
});
