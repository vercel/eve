// Run: node --conditions=eve-source packages/eve/src/execution/code-mode/runtime-bench.mjs
import { performance } from "node:perf_hooks";
import { MontyProgramRuntime } from "./monty-runtime.ts";
const rows = [];
async function measure(runtime, label, calls) {
  const source =
    runtime.language === "py"
      ? calls
        ? `total = 0\nfor i in range(${calls}):\n    total += await echo({"value": 1})\ntotal`
        : "42"
      : calls
        ? `let total = 0; for (let i = 0; i < ${calls}; i++) total += await tools.echo({value: 1}); return total;`
        : "return 42;";
  const input = {
    source,
    toolNames: ["echo"],
    limits: {
      deadlineAt: Date.now() + 120000,
      memoryBytes: 64000000,
      maxInFlightCalls: 32,
      maxTotalCalls: 256,
    },
  };
  const start = performance.now();
  let step = await runtime.start(input);
  const results = [];
  while (step.status === "parked") {
    results.push(
      ...step.calls.map((call) => ({ index: call.index, status: "completed", output: 1 })),
    );
    step = await runtime.resume({ ...input, state: step.state, results });
  }
  if (step.status !== "completed" || step.output !== (calls || 42))
    throw new Error(JSON.stringify(step));
  rows.push({
    language: runtime.language,
    case: label,
    calls,
    ms: +(performance.now() - start).toFixed(3),
  });
}
const { JavaScriptProgramRuntime } = await import("./javascript.ts");
const runtimes = [new JavaScriptProgramRuntime(), new MontyProgramRuntime()];
for (const runtime of runtimes) {
  await measure(runtime, "cold", 0);
  await measure(runtime, "warm", 0);
  for (const count of [1, 10, 100]) await measure(runtime, "run", count);
}
for (const runtime of runtimes) await runtime.close?.();
console.table(rows);
console.log(JSON.stringify(rows));
