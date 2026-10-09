import type { EveEvalResult } from "eve/evals";
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
    if (result.id === "runtime/scores") assertScoreContract(result);
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

/** Checks that `t.score` results keep the score and report the rule separately. */
function assertScoreContract(result: EveEvalResult): void {
  const brevity = result.assertions.find((assertion) => assertion.key === "reply-brevity");
  const ping = result.assertions.find((assertion) => assertion.key === "mentions-ping");
  if (brevity === undefined || ping === undefined) {
    throw new Error(`Keyed scores missing: ${JSON.stringify(result.assertions)}`);
  }
  if (
    typeof brevity.score !== "number" ||
    brevity.passed !== undefined ||
    brevity.threshold !== undefined
  ) {
    throw new Error(`Tracked-only score carried a verdict: ${JSON.stringify(brevity)}`);
  }
  if (
    ping.score !== 1 ||
    ping.threshold !== 1 ||
    ping.passed !== true ||
    ping.severity !== "gate"
  ) {
    throw new Error(`Gated score lost its measurement or rule: ${JSON.stringify(ping)}`);
  }
}

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
