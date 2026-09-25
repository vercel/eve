import { EvalSessionManager } from "#evals/session-manager.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createScopedAssertions } from "#evals/assertions/scoped.js";
import { buildJudgeContext } from "#evals/judge.js";
import { EvalRequirementFailed, EvalSkipped } from "#evals/control-flow.js";
import type {
  Assertion,
  AssertionEvaluation,
  AssertionHandle,
  EveEvalContext,
  EveEvalJudgeConfig,
  EveEvalTargetHandle,
} from "#evals/types.js";

/**
 * Builds the `EveEvalContext` (`t`) for one eval run, wiring the session
 * manager (driving), the assertion collector (recording), and the judge
 * namespace. Returns the collector so the runner can {@link
 * AssertionCollector.finalize} it against the completed task result.
 */
export function createEvalContext(deps: {
  readonly setupContext?: unknown;
  readonly manager: EvalSessionManager;
  readonly collector: AssertionCollector;
  readonly target: EveEvalTargetHandle;
  readonly signal: AbortSignal;
  readonly judge: EveEvalJudgeConfig | undefined;
  readonly log: (message: string) => void;
}): { readonly context: EveEvalContext; readonly collector: AssertionCollector } {
  const collector = deps.collector;
  const judge = buildJudgeContext({
    collector,
    getReply: () => deps.manager.lastTurnSession()?.lastTurn?.message ?? null,
    getInput: () => deps.manager.lastTurnSession()?.lastInput ?? "",
    judge: deps.judge,
    signal: deps.signal,
  });

  const context: EveEvalContext = {
    session: (options) => deps.manager.session(options),
    send: (message, options) => deps.manager.send(message, options),

    // Run context.
    context: deps.setupContext,
    signal: deps.signal,
    target: deps.target,
    log: deps.log,
    sleep: (ms) => sleep(ms, deps.signal),
    ...createScopedAssertions(collector, { timing: "final", select: (result) => result }),

    // Value-level assertion over an explicit value.
    check: (value, assertion) => recordCheck(collector, value, assertion),
    require: (value, assertion) => requireCheck(collector, value, assertion),
    skip: (reason) => {
      if (reason.trim().length === 0) throw new Error("skip() requires a non-empty reason.");
      if (collector.hasEntries || deps.manager.hasActivity()) {
        throw new Error(
          "skip() must be called before creating sessions, sending messages, or recording assertions.",
        );
      }
      throw new EvalSkipped(reason);
    },

    judge,
  };

  return { context, collector };
}

async function requireCheck<T>(
  collector: AssertionCollector,
  value: T,
  assertion: Assertion,
): Promise<T> {
  const gated = assertion.gate(assertion.threshold);
  const passed = await collector.recordRequirement({
    name: gated.name,
    threshold: gated.threshold,
    score: () => evaluateAssertion(gated, value),
  });
  if (!passed) throw new EvalRequirementFailed();
  return value;
}

function recordCheck(
  collector: AssertionCollector,
  value: unknown,
  assertion: Assertion,
): AssertionHandle {
  return collector.recordValue({
    name: assertion.name,
    severity: assertion.severity,
    threshold: assertion.threshold,
    score: () => evaluateAssertion(assertion, value),
  });
}

async function evaluateAssertion(
  assertion: Assertion,
  value: unknown,
): Promise<AssertionEvaluation> {
  if (assertion.evaluate !== undefined) {
    return await assertion.evaluate(value);
  }
  return { score: await assertion.score(value) };
}

function sleep(ms = 1_000, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("sleep() duration must be a non-negative finite number.");
  }

  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
