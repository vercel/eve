import { performance } from "node:perf_hooks";
import { JavaScriptProgramRuntime } from "../src/execution/code-mode/javascript.ts";
import type { ProgramCallResult } from "../src/execution/code-mode/runtime.ts";

async function measure(count: number) {
  const runtime = new JavaScriptProgramRuntime();
  const input = {
    source: `let value = 0; for (let i = 0; i < ${count}; i++) value = await tools.echo({ value: i + 1 }); return value;`,
    toolNames: ["echo"],
    limits: {
      deadlineAt: Date.now() + 300000,
      memoryBytes: 64 * 1024 * 1024,
      maxInFlightCalls: 32,
      maxTotalCalls: 256,
    },
  };
  const results: ProgramCallResult[] = [];
  const started = performance.now();
  let step = await runtime.start(input);
  while (step.status === "parked") {
    for (const call of step.calls)
      results.push({
        index: call.index,
        status: "completed",
        output: (call.input as { value: number }).value,
      });
    step = await runtime.resume({ ...input, state: step.state, results });
  }
  if (step.status !== "completed" || step.output !== count) throw new Error(JSON.stringify(step));
  const elapsed = performance.now() - started;
  if ("close" in runtime) (runtime as JavaScriptProgramRuntime & { close(): void }).close();
  return Math.round(elapsed * 10) / 10;
}
await measure(1); // Warm the vendor module, compiled WASM, and worker pool before timing.
for (const count of [1, 10, 100]) {
  const samples = [];
  for (let run = 0; run < 3; run++) samples.push(await measure(count));
  const median = [...samples].sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ count, samplesMs: samples, medianMs: median }));
}
