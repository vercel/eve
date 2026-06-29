import type { Client } from "#client/client.js";
import type {
  EveEval,
  EveEvalConfig,
  EveEvalResult,
  EveEvalRunSummary,
  EveEvalTargetHandle,
} from "#evals/types.js";
import { resolveArtifactDirectory, writeArtifacts } from "#evals/runner/artifacts.js";
import { executeEval } from "#evals/runner/execute-eval.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

const DEFAULT_MAX_CONCURRENCY = 8;

/**
 * Options for executing a set of evals as one run.
 */
export interface RunEvalsOptions {
  readonly evaluations: readonly EveEval[];
  /** Run-wide configuration from `evals.config.ts` (defaults shared by every eval). */
  readonly config: EveEvalConfig;
  readonly target: EveEvalTargetHandle;
  readonly client: Client;
  readonly appRoot: string;
  /** Run-level reporters (console, JUnit) that observe every eval. */
  readonly reporters: readonly EvalReporter[];
  /** When false, eval-defined and config `reporters` are ignored (CLI `--skip-report`). */
  readonly includeEvalReporters?: boolean;
  /**
   * Maximum number of evals executing at once. Must be a positive integer.
   * Overrides the config `maxConcurrency`; defaults to 8 when neither is set.
   */
  readonly maxConcurrency?: number;
  /** Overrides every eval's `timeoutMs` when set (CLI `--timeout`). */
  readonly timeoutMs?: number;
  /** Receives `t.log` lines as evals run (used by `--verbose`). */
  readonly onEvalLog?: (evalId: string, message: string) => void;
}

/** One reporter bound to the subset of evals that should observe it. */
interface ReporterBinding {
  readonly reporter: EvalReporter;
  readonly evalIds: ReadonlySet<string>;
}

/**
 * Executes every eval with bounded concurrency, drives reporters, writes
 * run artifacts under `.eve/evals/`, and returns the aggregated summary.
 *
 * Run-level reporters observe every eval. Eval-defined reporters observe
 * only the evals that reference them; a reporter instance shared by several
 * evals (e.g. one `Braintrust()` passed to every entry of an array export)
 * is deduplicated and observes all of its evals as one group.
 */
export async function runEvals(options: RunEvalsOptions): Promise<EveEvalRunSummary> {
  const { config, target, client, appRoot } = options;
  const maxConcurrency = options.maxConcurrency ?? config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  // A non-positive (or NaN) pool size would make the scheduling loop below
  // spin forever without ever starting a task or yielding to the event loop.
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(
      `Eval maxConcurrency must be a positive integer; got ${String(
        options.maxConcurrency ?? config.maxConcurrency,
      )}.`,
    );
  }

  const evaluations = options.evaluations.map((evaluation) =>
    applyConfigDefaults(evaluation, config),
  );
  const startedAt = new Date().toISOString();
  const bindings = buildReporterBindings({ ...options, evaluations });

  for (const binding of bindings) {
    await binding.reporter.onRunStart(
      evaluations.filter((evaluation) => binding.evalIds.has(evaluation.id)),
      target,
    );
  }

  const results: EveEvalResult[] = [];

  // Execute evals with bounded concurrency. Reporter callbacks run on a
  // serial queue off the hot path so a slow reporter never throttles the
  // pool; the queue drains before the run completes.
  const pending = [...evaluations];
  const executing = new Set<Promise<void>>();
  let reporterQueue: Promise<void> = Promise.resolve();

  while (pending.length > 0 || executing.size > 0) {
    while (pending.length > 0 && executing.size < maxConcurrency) {
      const evaluation = pending.shift();
      if (evaluation === undefined) break;

      const task = (async () => {
        const result = await executeEval({
          client,
          evaluation,
          onLog:
            options.onEvalLog === undefined
              ? undefined
              : (message) => options.onEvalLog?.(evaluation.id, message),
          target,
          timeoutMs: options.timeoutMs,
        });
        results.push(result);

        reporterQueue = reporterQueue.then(async () => {
          for (const binding of bindings) {
            if (binding.evalIds.has(result.id)) {
              await binding.reporter.onEvalComplete(result);
            }
          }
        });
      })();

      const tracked = task.finally(() => {
        executing.delete(tracked);
      });
      executing.add(tracked);
    }

    if (executing.size > 0) {
      await Promise.race(executing);
    }
  }

  await reporterQueue;

  // Report results in discovery order regardless of completion order.
  const order = new Map(evaluations.map((evaluation, index) => [evaluation.id, index]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const summary = buildSummary(target, results, startedAt);

  const artifactDir = resolveArtifactDirectory(appRoot);
  await writeArtifacts(artifactDir, summary);

  for (const binding of bindings) {
    await binding.reporter.onRunComplete(scopeSummary(summary, binding.evalIds));
  }

  return summary;
}

function buildReporterBindings(
  options: Omit<RunEvalsOptions, "evaluations"> & { readonly evaluations: readonly EveEval[] },
): ReporterBinding[] {
  const allIds = new Set(options.evaluations.map((evaluation) => evaluation.id));

  // Run-level reporters (CLI console/JUnit and config reporters) each observe
  // every eval. A reporter instance is bound at most once, so referencing a
  // config reporter from an eval too does not double-fire its callbacks.
  const runLevel = new Set<EvalReporter>(options.reporters);
  if (options.includeEvalReporters !== false) {
    for (const reporter of options.config.reporters ?? []) {
      runLevel.add(reporter);
    }
  }

  const bindings: ReporterBinding[] = [...runLevel].map((reporter) => ({
    reporter,
    evalIds: allIds,
  }));

  if (options.includeEvalReporters === false) {
    return bindings;
  }

  const scoped = new Map<EvalReporter, Set<string>>();
  for (const evaluation of options.evaluations) {
    for (const reporter of evaluation.reporters ?? []) {
      if (runLevel.has(reporter)) continue;
      const ids = scoped.get(reporter) ?? new Set<string>();
      ids.add(evaluation.id);
      scoped.set(reporter, ids);
    }
  }

  for (const [reporter, evalIds] of scoped) {
    bindings.push({ reporter, evalIds });
  }

  return bindings;
}

/**
 * Fills an eval's judge model from the run config when the eval does not set
 * its own. The judge model only ever drives `t.judge.*` assertions.
 */
function applyConfigDefaults(evaluation: EveEval, config: EveEvalConfig): EveEval {
  if (evaluation.judge !== undefined || config.judge === undefined) {
    return evaluation;
  }
  return {
    ...evaluation,
    judge: config.judge,
  };
}

function buildSummary(
  target: RunEvalsOptions["target"],
  results: readonly EveEvalResult[],
  startedAt: string,
): EveEvalRunSummary {
  return {
    target,
    results,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: countVerdicts(results, "passed"),
    failed: countVerdicts(results, "failed"),
    scored: countVerdicts(results, "scored"),
    skipped: countVerdicts(results, "skipped"),
    errored: results.filter((r) => r.error !== undefined).length,
  };
}

/** Narrows a run summary to the subset of results a scoped reporter observes. */
function scopeSummary(summary: EveEvalRunSummary, evalIds: ReadonlySet<string>): EveEvalRunSummary {
  if (summary.results.every((result) => evalIds.has(result.id))) {
    return summary;
  }

  const results = summary.results.filter((result) => evalIds.has(result.id));
  return {
    ...summary,
    results,
    passed: countVerdicts(results, "passed"),
    failed: countVerdicts(results, "failed"),
    scored: countVerdicts(results, "scored"),
    skipped: countVerdicts(results, "skipped"),
    errored: results.filter((r) => r.error !== undefined).length,
  };
}

function countVerdicts(
  results: readonly EveEvalResult[],
  verdict: EveEvalResult["verdict"],
): number {
  return results.filter((result) => result.verdict === verdict).length;
}
