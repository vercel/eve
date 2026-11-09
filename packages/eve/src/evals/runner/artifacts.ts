import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EveEvalResult, EveEvalRunSummary } from "#evals/types.js";

/**
 * Resolves the artifact output directory for one `eve eval` run.
 *
 * Layout: `.eve/evals/<timestamp>/`
 */
export function resolveArtifactDirectory(appRoot: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(appRoot, ".eve", "evals", timestamp);
}

/**
 * Writes all artifacts for a completed eval run: a run summary, a JSONL
 * results index, and per-eval detail/event files under `evals/`.
 */
export async function writeArtifacts(
  artifactDir: string,
  summary: EveEvalRunSummary,
): Promise<void> {
  const evalsDir = join(artifactDir, "evals");
  await mkdir(evalsDir, { recursive: true });

  await writeFile(
    join(artifactDir, "summary.json"),
    JSON.stringify(buildSummaryArtifact(summary), null, 2),
  );

  const resultsLines = summary.results
    .map((result) => JSON.stringify(buildResultLine(result)))
    .join("\n");
  await writeFile(join(artifactDir, "results.jsonl"), `${resultsLines}\n`);

  await Promise.all(
    summary.results.map(async (result) => {
      const basePath = join(evalsDir, artifactBaseName(result));
      await mkdir(dirname(basePath), { recursive: true });
      await writeFile(`${basePath}.json`, JSON.stringify(buildEvalArtifact(result), null, 2));

      const eventLines = result.result.events.map((event) => JSON.stringify(event)).join("\n");
      await writeFile(`${basePath}.events.ndjson`, `${eventLines}\n`);
    }),
  );
}

function buildSummaryArtifact(summary: EveEvalRunSummary): Record<string, unknown> {
  return {
    target: summary.target,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    passed: summary.passed,
    failed: summary.failed,
    scored: summary.scored,
    skipped: summary.skipped,
    errored: summary.errored,
    totalEvals: summary.results.length,
    evals: summary.results.map((result) => ({
      id: result.id,
      attempt: result.attempt,
      verdict: result.verdict,
      status: result.result.status,
      outcome: result.result.outcome,
      assertions: result.assertions.map((a) => ({
        name: a.name,
        key: a.key,
        score: a.score,
        severity: a.severity,
        threshold: a.threshold,
        passed: a.passed,
        errored: a.errored,
        message: a.message,
        metadata: a.metadata,
      })),
      error: result.error,
      skipReason: result.skipReason,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      traceContexts: result.result.traceContexts,
    })),
  };
}

function buildResultLine(result: EveEvalResult): Record<string, unknown> {
  return {
    id: result.id,
    attempt: result.attempt,
    verdict: result.verdict,
    status: result.result.status,
    outcome: result.result.outcome,
    data: result.result.data,
    reply: result.result.reply,
    sessionEnded: result.result.sessionEnded,
    assertions: result.assertions,
    error: result.error,
    skipReason: result.skipReason,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    traceContexts: result.result.traceContexts,
  };
}

function buildEvalArtifact(result: EveEvalResult): Record<string, unknown> {
  return {
    id: result.id,
    attempt: result.attempt,
    result: {
      outcome: result.result.outcome,
      error: result.result.error,
      data: result.result.data,
      reply: result.result.reply,
      sessionEnded: result.result.sessionEnded,
      sessionId: result.result.sessionId,
      status: result.result.status,
      logs: result.result.logs,
      derived: result.result.derived,
      runtimeIdentity: result.result.runtimeIdentity,
      sessions: result.result.sessions,
      traceContexts: result.result.traceContexts,
    },
    verdict: result.verdict,
    assertions: result.assertions,
    error: result.error,
    skipReason: result.skipReason,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
}

/**
 * Repeated attempts get an `.attempt-<n>` suffix. Sanitizing replaces `.` in
 * ids, so the suffix cannot collide with another eval's artifact path.
 */
function artifactBaseName(result: EveEvalResult): string {
  const base = sanitizeArtifactPath(result.id);
  return result.attempt === undefined ? base : `${base}.attempt-${result.attempt}`;
}

/**
 * Eval ids contain `/` for directory nesting; keep that nesting in the
 * artifact tree and sanitize every other unsafe character per segment.
 */
function sanitizeArtifactPath(id: string): string {
  return id
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, "_"))
    .join("/");
}
