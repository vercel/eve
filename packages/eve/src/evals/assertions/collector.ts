import { toErrorMessage } from "#shared/errors.js";
import { formatAssertionName } from "#evals/diagnostics.js";
import type {
  AssertionEvaluation,
  AssertionHandle,
  AssertionResult,
  AssertionSeverity,
  EveEvalTaskResult,
} from "#evals/types.js";
import type { TargetTools } from "#evals/target.js";
import type { EveEvalAssertionSubject } from "#evals/assertions/run.js";

export type AssertionOutcome = AssertionEvaluation;

/** A raw score or rich evaluation accepted by `t.score`, possibly still pending. */
export type ScoreInput = number | AssertionOutcome | Promise<number | AssertionOutcome>;

/**
 * A scoped assertion evaluated lazily after `test(t)` returns. The selected
 * subject may be the aggregate run, one session, or one immutable turn.
 */
export interface RunAssertion {
  readonly name: string;
  evaluate(result: EveEvalAssertionSubject): AssertionOutcome | Promise<AssertionOutcome>;
}

interface MutableEntry {
  readonly baseName: string;
  name: string;
  key: string | undefined;
  severity: AssertionSeverity;
  threshold: number | undefined;
  readonly kind: "deferred" | "resolved";
  readonly spec?: RunAssertion;
  readonly selectSubject?: (result: EveEvalTaskResult) => EveEvalAssertionSubject;
  /** Raw measurement once produced; stays `undefined` when the scorer threw. */
  score: number | undefined;
  message?: string;
  metadata?: Readonly<Record<string, unknown>>;
  /** A model/value assertion that threw — a hard failure regardless of severity. */
  errored: boolean;
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

  /** The target's root agent tools, which tool-name assertions are checked against. */
  readonly tools: TargetTools | undefined;

  constructor(tools?: TargetTools) {
    this.tools = tools;
  }

  /** Whether the eval has already recorded an assertion. */
  get hasEntries(): boolean {
    return this.#entries.length > 0;
  }

  /** Register a deferred assertion against a turn or session scope. */
  recordScoped(
    spec: RunAssertion,
    selectSubject: (result: EveEvalTaskResult) => EveEvalAssertionSubject,
    severity: AssertionSeverity = "gate",
  ): AssertionHandle {
    const entry = this.#add({ name: spec.name, severity, kind: "deferred", spec, selectSubject });
    return makeHandle(entry);
  }

  /** Register a value/judge assertion, evaluating the captured value now. */
  recordValue(input: {
    readonly name: string;
    readonly key?: string;
    readonly severity: AssertionSeverity;
    readonly threshold?: number;
    readonly score: () => Promise<AssertionOutcome>;
  }): AssertionHandle {
    const entry = this.#add({ ...input, kind: "resolved" });
    this.#pending.push(settleEntry(entry, input.score));
    return makeHandle(entry);
  }

  /** Record a raw score. It has no verdict unless the handle chains `.gate()` or `.atLeast()`. */
  recordScore(evaluation: ScoreInput): AssertionHandle {
    return this.recordValue({
      name: "score",
      severity: "soft",
      score: async () => toOutcome(await evaluation),
    });
  }

  /** Record an already-computed assertion outcome and return whether it passed. */
  recordOutcome(input: { readonly name: string; readonly outcome: AssertionOutcome }): boolean {
    const entry = this.#add({ name: input.name, severity: "gate", kind: "resolved" });
    entry.score = input.outcome.score;
    entry.message = input.outcome.message;
    entry.metadata = input.outcome.metadata;
    return computePassed(entry) === true;
  }

  /** Record and await a required value assertion, returning whether it passed. */
  async recordRequirement(input: {
    readonly name: string;
    readonly threshold?: number;
    readonly score: () => Promise<AssertionOutcome>;
  }): Promise<boolean> {
    const entry = this.#add({ ...input, severity: "gate", kind: "resolved" });
    await settleEntry(entry, input.score);
    return computePassed(entry) === true;
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
        const outcome = await entry.spec.evaluate(entry.selectSubject?.(result) ?? result);
        entry.score = outcome.score;
        entry.message = outcome.message;
        entry.metadata = outcome.metadata;
      }
      results.push(toResult(entry));
    }
    return results;
  }

  #add(input: {
    readonly name: string;
    readonly key?: string;
    readonly severity: AssertionSeverity;
    readonly threshold?: number;
    readonly kind: MutableEntry["kind"];
    readonly spec?: RunAssertion;
    readonly selectSubject?: MutableEntry["selectSubject"];
  }): MutableEntry {
    const entry: MutableEntry = {
      baseName: input.name,
      name: input.name,
      key: input.key,
      severity: input.severity,
      threshold: input.threshold,
      kind: input.kind,
      spec: input.spec,
      selectSubject: input.selectSubject,
      score: undefined,
      errored: false,
    };
    this.#entries.push(entry);
    return entry;
  }
}

function toResult(entry: MutableEntry): AssertionResult {
  return {
    name: entry.name,
    key: entry.key,
    score: entry.score,
    severity: entry.severity,
    threshold: entry.errored ? undefined : ruleThreshold(entry),
    passed: computePassed(entry),
    errored: entry.errored,
    message: entry.message,
    metadata: entry.metadata,
  };
}

/** The effective minimum passing score: a gate defaults to 1, a soft entry has none. */
function ruleThreshold(entry: MutableEntry): number | undefined {
  return entry.threshold ?? (entry.severity === "gate" ? 1 : undefined);
}

/**
 * Verdict of the entry's acceptance rule. A thrown scorer never passes; an
 * entry without a rule (soft, no threshold) is tracked only and has no verdict.
 */
function computePassed(entry: MutableEntry): boolean | undefined {
  if (entry.errored) return false;
  const threshold = ruleThreshold(entry);
  if (threshold === undefined) return undefined;
  return entry.score !== undefined && entry.score >= threshold;
}

function toOutcome(value: number | AssertionOutcome): AssertionOutcome {
  const outcome = typeof value === "number" ? { score: value } : value;
  if (typeof outcome.score !== "number" || !Number.isFinite(outcome.score)) {
    throw new TypeError(`Scores must be finite numbers; received ${String(outcome.score)}.`);
  }
  return outcome;
}

async function settleEntry(
  entry: MutableEntry,
  score: () => Promise<AssertionOutcome>,
): Promise<void> {
  try {
    const outcome = await score();
    entry.score = outcome.score;
    entry.message = outcome.message;
    entry.metadata = outcome.metadata;
  } catch (error: unknown) {
    // A judge/value assertion that throws (e.g. a judge model error) is a
    // hard failure, surfaced as a failed gate rather than aborting the run.
    // A thrown scorer produces no measurement, so the score stays absent.
    entry.severity = "gate";
    entry.threshold = undefined;
    entry.message = toErrorMessage(error);
    entry.errored = true;
  }
}

function makeHandle(entry: MutableEntry): AssertionHandle {
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
    label(label) {
      entry.name = formatAssertionName(entry.baseName, label);
      entry.key = label.trim();
      return handle;
    },
  };
  return handle;
}
