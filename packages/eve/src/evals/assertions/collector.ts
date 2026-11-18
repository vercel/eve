import { toErrorMessage } from "#shared/errors.js";
import { outputOf } from "#evals/output.js";
import { formatAssertionName } from "#evals/diagnostics.js";
import type {
  AssertionEvaluation,
  AssertionHandle,
  AssertionResult,
  AssertionSeverity,
  EveEvalTaskResult,
  ScoreInput,
} from "#evals/types.js";
import type { TargetTools } from "#evals/target.js";
import type { EveEvalAssertionSubject } from "#evals/assertions/run.js";

export type AssertionOutcome = AssertionEvaluation;

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
  score: number | undefined;
  message?: string;
  metadata?: Readonly<Record<string, unknown>>;
  errored: boolean;
}

export class AssertionCollector {
  readonly #entries: MutableEntry[] = [];
  readonly #pending: Promise<void>[] = [];

  readonly tools: TargetTools | undefined;

  constructor(tools?: TargetTools) {
    this.tools = tools;
  }

  get hasEntries(): boolean {
    return this.#entries.length > 0;
  }

  recordScoped(
    spec: RunAssertion,
    selectSubject: (result: EveEvalTaskResult) => EveEvalAssertionSubject,
    severity: AssertionSeverity = "gate",
  ): AssertionHandle {
    const entry = this.#add({ name: spec.name, severity, kind: "deferred", spec, selectSubject });
    return makeHandle(entry);
  }

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

  recordScore(evaluation: ScoreInput): AssertionHandle {
    return this.recordValue({
      name: "score",
      severity: "soft",
      score: async () => toOutcome(await evaluation),
    });
  }

  recordOutcome(input: { readonly name: string; readonly outcome: AssertionOutcome }): boolean {
    const entry = this.#add({ name: input.name, severity: "gate", kind: "resolved" });
    entry.score = input.outcome.score;
    entry.message = input.outcome.message;
    entry.metadata = input.outcome.metadata;
    return computePassed(entry) === true;
  }

  async recordRequirement(input: {
    readonly name: string;
    readonly threshold?: number;
    readonly score: () => Promise<AssertionOutcome>;
  }): Promise<boolean> {
    const entry = this.#add({ ...input, severity: "gate", kind: "resolved" });
    await settleEntry(entry, input.score);
    return computePassed(entry) === true;
  }

  async finalize(result: EveEvalTaskResult): Promise<readonly AssertionResult[]> {
    await Promise.all(this.#pending);

    const results: AssertionResult[] = [];
    for (const entry of this.#entries) {
      if (entry.kind === "deferred" && entry.spec !== undefined) {
        const outcome = await entry.spec.evaluate(
          entry.selectSubject?.(result) ?? { ...result, output: outputOf(result) },
        );
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

function ruleThreshold(entry: MutableEntry): number | undefined {
  return entry.threshold ?? (entry.severity === "gate" ? 1 : undefined);
}

function computePassed(entry: MutableEntry): boolean | undefined {
  if (entry.errored) return false;
  const threshold = ruleThreshold(entry);
  if (threshold === undefined) return undefined;
  return entry.score !== undefined && entry.score >= threshold;
}

function toOutcome(value: number | AssertionOutcome): AssertionOutcome {
  const outcome = typeof value === "number" ? { score: value } : value;
  if (typeof outcome.score !== "number" || !(outcome.score >= 0 && outcome.score <= 1)) {
    throw new TypeError(`Scores must be numbers from 0 to 1; received ${String(outcome.score)}.`);
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
