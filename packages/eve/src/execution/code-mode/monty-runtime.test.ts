import { afterAll, describe, expect, it } from "vitest";
import { MontyProgramRuntime } from "./monty-runtime.js";
import { renderPythonSignature } from "../catalog/python-signatures.js";
const runtime = new MontyProgramRuntime();
afterAll(() => runtime.close());
function input(source: string) {
  return {
    source,
    toolNames: ["echo"],
    limits: {
      deadlineAt: Date.now() + 10000,
      memoryBytes: 10000000,
      maxInFlightCalls: 32,
      maxTotalCalls: 256,
    },
  };
}
describe("Monty recorded-call replay", () => {
  it("starts, parks and replays deterministically", async () => {
    const program = input('x = await echo({"x": 1})\nawait echo(x)');
    const first = await runtime.start(program);
    expect(first).toMatchObject({
      status: "parked",
      calls: [{ index: 0, tool: "echo", input: { x: 1 } }],
      state: expect.any(String),
    });
    const resume = {
      ...program,
      state: null,
      results: [{ index: 0, status: "completed" as const, output: { x: 2 } }],
    };
    expect(await runtime.resume(resume)).toMatchObject({ status: "parked", calls: [{ index: 1 }] });
    expect(
      await runtime.resume({
        ...resume,
        results: [...resume.results, { index: 1, status: "completed", output: 3 }],
      }),
    ).toMatchObject({ status: "completed", output: 3 });
  });
  it("continues a live execution and replays after losing its cache", async () => {
    const program = input('first = await echo({"x": 1})\nawait echo(first)');
    const first = await runtime.start(program);
    if (first.status !== "parked") throw new Error("Expected park");
    const resumed = {
      ...program,
      state: first.state,
      results: [{ index: 0, status: "completed" as const, output: 2 }],
    };
    const live = await runtime.resume(resumed);
    const restarted = new MontyProgramRuntime();
    try {
      const replay = await restarted.resume(resumed);
      expect(live).toMatchObject({ status: "parked", calls: [{ index: 1, input: 2 }] });
      expect(replay).toMatchObject({ status: "parked", calls: [{ index: 1, input: 2 }] });
      if (live.status !== "parked") throw new Error("Expected park");
      expect(
        await runtime.resume({
          ...resumed,
          state: live.state,
          results: [...resumed.results, { index: 1, status: "completed", output: 3 }],
        }),
      ).toMatchObject({ status: "completed", output: 3 });
    } finally {
      await restarted.close();
    }
  });
  it("reports cold readiness, warm/live zero startup and execution slices", async () => {
    const measured = new MontyProgramRuntime();
    try {
      const cold = await measured.start(input("42"));
      expect(cold.timing!.startupMs).toBeGreaterThan(0);
      expect(cold.timing!.runMs).toBeGreaterThan(0);
      const warm = await measured.start(input("42"));
      expect(warm.timing!.startupMs).toBe(0);
      const program = input("await echo({})");
      const parked = await measured.start(program);
      if (parked.status !== "parked") throw new Error("Expected park");
      // Parked time is outside the measured interpreter operations.
      await new Promise((resolve) => setTimeout(resolve, 75));
      const done = await measured.resume({
        ...program,
        state: parked.state,
        results: [{ index: 0, status: "completed", output: 1 }],
      });
      expect(done.timing!.startupMs).toBe(0);
      expect(done.timing!.runMs).toBeGreaterThan(0);
      expect(done.timing!.runMs).toBeLessThan(75);
    } finally {
      await measured.close();
    }
  });
  it.each(["failed", "unknown"] as const)("raises %s in Python", async (status) => {
    const program = input(
      "try:\n    await echo({})\nexcept Exception as e:\n    result = str(e)\nresult",
    );
    expect(
      await runtime.resume({
        ...program,
        state: null,
        results: [{ index: 0, status, error: "boom" }],
      }),
    ).toMatchObject({ status: "completed", output: expect.stringContaining("boom") });
  });
  it.each(["import time\ntime.time()", "import random\nrandom.random()"])(
    "denies nondeterminism",
    async (source) => {
      expect(await runtime.start(input(source))).toMatchObject({ status: "failed" });
    },
  );
  it("enforces deadline and total calls", async () => {
    const program = input("await echo({})");
    expect(
      await runtime.start({ ...program, limits: { ...program.limits, deadlineAt: 0 } }),
    ).toMatchObject({ status: "failed", errorClass: "deadline" });
    expect(
      await runtime.start({ ...program, limits: { ...program.limits, maxTotalCalls: 0 } }),
    ).toMatchObject({ status: "failed", errorClass: "call-limit" });
  });
  it("batches asyncio.gather", async () => {
    expect(
      await runtime.start(
        input('import asyncio\nawait asyncio.gather(echo({"x": 1}), echo({"x": 2}))'),
      ),
    ).toMatchObject({ status: "parked", calls: [{ index: 0 }, { index: 1 }] });
  });
  it("renders Python TypedDict stubs", () => {
    expect(
      renderPythonSignature({
        name: "echo",
        inputSchema: {
          type: "object",
          properties: { "a-b": { type: "string" } },
          required: ["a-b"],
        },
        outputSchema: { type: "integer" },
      }),
    ).toContain('"a-b": Required[str]');
  });
  it("review: replaying an older durable checkpoint must expose its next unresolved call", async () => {
    const program = input('first = await echo({"x": 1})\nawait echo(first)');
    const first = await runtime.start(program);
    if (first.status !== "parked") throw new Error("expected park");
    const checkpoint = {
      ...program,
      state: first.state,
      results: [{ index: 0, status: "completed" as const, output: 2 }],
    };
    const next = await runtime.resume(checkpoint);
    expect(next).toMatchObject({ status: "parked", calls: [{ index: 1, input: 2 }] });
    const replay = await runtime.resume(checkpoint);
    expect(replay).toMatchObject({ status: "parked", calls: [{ index: 1, input: 2 }] });
  });
  it("review: print logs must be bounded outside guest memory", async () => {
    const result = await runtime.start(input('for i in range(1000):\n    print("x" * 1024)\n42'));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.logs.join("").length).toBeLessThanOrEqual(16 * 1024);
  });

  it("retains bounded UTF-8 logs on failure", async () => {
    const result = await runtime.start(
      input(
        'for i in range(1000):\n    print("😀" * 1024)\nraise ValueError("failure after printing")',
      ),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(result.logs.join(""))).toBeLessThanOrEqual(16 * 1024);
    expect(result.error).toContain("failure after printing");
  });
});
