import type { Client } from "#client/client.js";
import type {
  EveEval,
  EveEvalConfig,
  EveEvalResult,
  EveEvalRunSummary,
  EveEvalTargetHandle,
} from "#evals/types.js";
import { resolveArtifactDirectory, writeArtifacts } from "#evals/runner/artifacts.js";
import { formatAttemptLabel } from "#evals/runner/attempt-label.js";
import { executeEval } from "#evals/runner/execute-eval.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

const DEFAULT_MAX_CONCURRENCY = 8;

export interface RunEvalsOptions {
  readonly evaluations: readonly EveEval[];
  readonly config: EveEvalConfig;
  readonly setupContext?: unknown;
  readonly target: EveEvalTargetHandle;
  readonly client: Client;
  readonly appRoot: string;
  readonly reporters: readonly EvalReporter[];
  readonly includeEvalReporters?: boolean;
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly repeat?: number;
  readonly onEvalLog?: (evalId: string, message: string) => void;
}

interface ReporterBinding {
  readonly reporter: EvalReporter;
  readonly evalIds: ReadonlySet<string>;
}

export async function runEvals(options: RunEvalsOptions): Promise<EveEvalRunSummary> {
  const { config, target, client, appRoot } = options;
  const maxConcurrency = options.maxConcurrency ?? config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(
      `Eval maxConcurrency must be a positive integer; got ${String(
        options.maxConcurrency ?? config.maxConcurrency,
      )}.`,
    );
  }

  const repeat = options.repeat ?? config.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(
      `Eval repeat must be a positive integer; got ${String(options.repeat ?? config.repeat)}.`,
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

  const pending = evaluations.flatMap((evaluation) =>
    Array.from({ length: repeat }, (_, index) => ({
      evaluation,
      attempt: repeat > 1 ? index + 1 : undefined,
    })),
  );
  const executing = new Set<Promise<void>>();
  let reporterQueue: Promise<void> = Promise.resolve();
  const enqueueReporterCallback = (
    evaluation: EveEval,
    callback: (reporter: EvalReporter) => void | Promise<void>,
  ): void => {
    reporterQueue = reporterQueue.then(async () => {
      for (const binding of bindings) {
        if (binding.evalIds.has(evaluation.id)) {
          await callback(binding.reporter);
        }
      }
    });
  };

  while (pending.length > 0 || executing.size > 0) {
    while (pending.length > 0 && executing.size < maxConcurrency) {
      const next = pending.shift();
      if (next === undefined) break;
      const { evaluation, attempt } = next;
      const logLabel = formatAttemptLabel(evaluation.id, attempt);
      const evalStartedAt = new Date().toISOString();

      enqueueReporterCallback(evaluation, async (reporter) => {
        await reporter.onEvalStart?.({
          evaluation,
          attempt,
          startedAt: evalStartedAt,
          target,
        });
      });

      const task = (async () => {
        const executed = await executeEval({
          client,
          evaluation,
          setupContext: options.setupContext,
          onLog:
            options.onEvalLog === undefined
              ? undefined
              : (message) => options.onEvalLog?.(logLabel, message),
          onSessionStart: (event) => {
            enqueueReporterCallback(evaluation, async (reporter) => {
              await reporter.onSessionStart?.({
                evaluation,
                attempt,
                primary: event.primary,
                sessionId: event.sessionId,
                startedAt: event.startedAt,
                target,
                traceContext: event.traceContext,
              });
            });
          },
          startedAt: evalStartedAt,
          target,
          timeoutMs: options.timeoutMs,
        });
        const result = attempt === undefined ? executed : { ...executed, attempt };
        results.push(result);

        for (const session of result.result.sessions ?? []) {
          if (session.sessionId === undefined) continue;
          const role = session.primary ? "primary session" : "secondary session";
          options.onEvalLog?.(logLabel, `workflow run id (${role}): ${session.sessionId}`);
        }

        enqueueReporterCallback(evaluation, async (reporter) => {
          await reporter.onEvalComplete(result, {
            evaluation,
            target,
            traceContexts: result.result.traceContexts,
          });
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

  const order = new Map(evaluations.map((evaluation, index) => [evaluation.id, index]));
  results.sort(
    (a, b) =>
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || (a.attempt ?? 0) - (b.attempt ?? 0),
  );

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

function applyConfigDefaults(evaluation: EveEval, config: EveEvalConfig): EveEval {
  const judge = evaluation.judge ?? config.judge;
  const timeoutMs = evaluation.timeoutMs ?? config.timeoutMs;

  if (judge === evaluation.judge && timeoutMs === evaluation.timeoutMs) {
    return evaluation;
  }

  return {
    ...evaluation,
    judge,
    timeoutMs,
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
