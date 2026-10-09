import type { EvalReporter } from "eve/evals/reporters";

const scheduled = new Set<string>();
const completed = new Set<string>();
let targetKind: "local" | "remote" = "remote";

/** Proves the public reporter lifecycle survives the full CLI/runtime boundary. */
export const evalLifecycleReporter: EvalReporter = {
  onRunStart(_evaluations, target) {
    scheduled.clear();
    completed.clear();
    targetKind = target.kind;
  },
  onEvalStart(event) {
    scheduled.add(event.evaluation.id);
  },
  onSessionStart(event) {
    if (!scheduled.has(event.evaluation.id)) {
      throw new Error(`Session callback preceded eval start: ${event.evaluation.id}`);
    }
    assertTraceContext(event.traceContext);
  },
  onEvalComplete(result, context) {
    if (!scheduled.has(result.id)) {
      throw new Error(`Completion callback preceded eval start: ${result.id}`);
    }
    if (context === undefined) {
      throw new Error(`Completion callback omitted context: ${result.id}`);
    }
    for (const traceContext of context.traceContexts) {
      assertTraceContext(traceContext);
    }
    if (targetKind === "local" && context.traceContexts.length === 0) {
      throw new Error(`Local eval exposed no trace context: ${result.id}`);
    }
    completed.add(result.id);
  },
  onRunComplete(summary) {
    if (scheduled.size !== summary.results.length || completed.size !== summary.results.length) {
      throw new Error(
        `Reporter lifecycle mismatch: ${scheduled.size} started, ${completed.size} completed, ${summary.results.length} results.`,
      );
    }
  },
};

function assertTraceContext(trace: {
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}): void {
  if (!/^[0-9a-f]{32}$/u.test(trace.traceId) || !/^[0-9a-f]{16}$/u.test(trace.spanId)) {
    throw new Error(`Invalid trace context: ${JSON.stringify(trace)}`);
  }
  if (!Number.isInteger(trace.traceFlags)) {
    throw new Error(`Invalid trace flags: ${String(trace.traceFlags)}`);
  }
}
