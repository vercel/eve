import { toErrorMessage } from "#shared/errors.js";
import type {
  AssertionHandle,
  AssertionResult,
  AssertionSeverity,
  EveEvalTaskResult,
} from "#evals/types.js";

/**
 * Outcome of evaluating one assertion: a 0–1 score (boolean assertions use
 * exactly 0 or 1) with optional human-readable detail and metadata.
 */
export interface AssertionOutcome {
  readonly score: number;
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A run-level assertion (e.g. `t.completed()`), evaluated lazily against the
 * final task result after `test(t)` returns. The evaluation is deferred so
 * the assertion always sees the complete run regardless of call order.
 */
export interface RunAssertion {
  readonly name: string;
  evaluate(result: EveEvalTaskResult): AssertionOutcome | Promise<AssertionOutcome>;
}

interface MutableEntry {
  name: string;
  severity: AssertionSeverity;
  threshold: number | undefined;
  readonly kind: "deferred" | "resolved";
  readonly spec?: RunAssertion;
  score: number;
  message?: string;
  metadata?: Readonly<Record<string, unknown>>;
  /** A model/value assertion that threw — a hard failure regardless of severity. */
  failed: boolean;
}

/**
 * Collects the assertions recorded by an eval's `test(t)`. Run-level
 * assertions register a deferred spec; value/judge assertions evaluate their
 * captured value immediately (the value is ephemeral) and register the pending
 * promise. {@link finalize} resolves everything against the final result and
 * produces the ordered {@link AssertionResult} list the verdict reads.
 */
export class AssertionCollector {
  readonly #entries: MutableEntry[] = [];
  readonly #pending: Promise<void>[] = [];

  /** Register a run-level assertion evaluated against the final result. */
  recordRun(spec: RunAssertion, severity: AssertionSeverity = "gate"): AssertionHandle {
    const entry: MutableEntry = {
      name: spec.name,
      severity,
      threshold: undefined,
      kind: "deferred",
      spec,
      score: 0,
      failed: false,
    };
    this.#entries.push(entry);
    return makeHandle(entry, Promise.resolve());
  }

  /** Register a value/judge assertion, evaluating the captured value now. */
  recordValue(input: {
    readonly name: string;
    readonly severity: AssertionSeverity;
    readonly threshold?: number;
    readonly score: () => Promise<AssertionOutcome>;
  }): AssertionHandle {
    const entry: MutableEntry = {
      name: input.name,
      severity: input.severity,
      threshold: input.threshold,
      kind: "resolved",
      score: 0,
      failed: false,
    };
    this.#entries.push(entry);

    const pending = input
      .score()
      .then((outcome) => {
        entry.score = outcome.score;
        entry.message = outcome.message;
        entry.metadata = outcome.metadata;
      })
      .catch((error: unknown) => {
        // A judge/value assertion that throws (e.g. a judge model error) is a
        // hard failure, surfaced as a failed gate rather than aborting the run.
        entry.score = 0;
        entry.severity = "gate";
        entry.threshold = undefined;
        entry.message = toErrorMessage(error);
        entry.failed = true;
      });

    this.#pending.push(pending);
    return makeHandle(entry, pending);
  }

  /**
   * Awaits every pending value/judge assertion, evaluates the deferred
   * run-level assertions against `result`, and returns the recorded results.
   */
  async finalize(result: EveEvalTaskResult): Promise<readonly AssertionResult[]> {
    await Promise.all(this.#pending);

    const results: AssertionResult[] = [];
    for (const entry of this.#entries) {
      if (entry.kind === "deferred" && entry.spec !== undefined) {
        const outcome = await entry.spec.evaluate(result);
        entry.score = outcome.score;
        entry.message = outcome.message;
        entry.metadata = outcome.metadata;
      }
      results.push({
        name: entry.name,
        score: entry.score,
        severity: entry.severity,
        threshold: entry.threshold,
        passed: computePassed(entry.severity, entry.threshold, entry.score, entry.failed),
        message: entry.message,
        metadata: entry.metadata,
      });
    }
    return results;
  }
}

/**
 * Whether an assertion meets its bar. A gate defaults to threshold 1; a soft
 * assertion with no threshold is tracked-only and always "passes". A hard
 * thrown failure never passes.
 */
function computePassed(
  severity: AssertionSeverity,
  threshold: number | undefined,
  score: number,
  failed: boolean,
): boolean {
  if (failed) return false;
  const min = threshold ?? (severity === "gate" ? 1 : undefined);
  return min === undefined || score >= min;
}

function makeHandle(entry: MutableEntry, pending: Promise<void>): AssertionHandle {
  const handle: AssertionHandle = {
    gate(threshold) {
      entry.severity = "gate";
      entry.threshold = threshold;
      return handle;
    },
    soft(threshold) {
      entry.severity = "soft";
      entry.threshold = threshold;
      return handle;
    },
    atLeast(threshold) {
      entry.severity = "soft";
      entry.threshold = threshold;
      return handle;
    },
    // The handle is intentionally a PromiseLike so `await t.judge.…()` resolves
    // the judge call and surfaces its errors before the run continues.
    // oxlint-disable-next-line no-thenable
    then(onfulfilled, onrejected) {
      return pending.then(onfulfilled, onrejected);
    },
  };
  return handle;
}
