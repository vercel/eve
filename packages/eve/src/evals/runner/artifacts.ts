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
      const detailPath = join(evalsDir, `${sanitizeArtifactPath(result.id)}.json`);
      await mkdir(dirname(detailPath), { recursive: true });
      await writeFile(detailPath, JSON.stringify(buildEvalArtifact(result), null, 2));

      const eventLines = result.result.events.map((event) => JSON.stringify(event)).join("\n");
      await writeFile(
        join(evalsDir, `${sanitizeArtifactPath(result.id)}.events.ndjson`),
        `${eventLines}\n`,
      );
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
      verdict: result.verdict,
      status: result.result.status,
      assertions: result.assertions.map((a) => ({
        name: a.name,
        score: a.score,
        severity: a.severity,
        passed: a.passed,
      })),
      error: result.error,
      skipReason: result.skipReason,
    })),
  };
}

function buildResultLine(result: EveEvalResult): Record<string, unknown> {
  return {
    id: result.id,
    verdict: result.verdict,
    status: result.result.status,
    output: result.result.output,
    assertions: result.assertions,
    error: result.error,
    skipReason: result.skipReason,
  };
}

function buildEvalArtifact(result: EveEvalResult): Record<string, unknown> {
  return {
    id: result.id,
    result: {
      output: result.result.output,
      finalMessage: result.result.finalMessage,
      sessionId: result.result.sessionId,
      status: result.result.status,
      logs: result.result.logs,
      derived: result.result.derived,
      sessions: result.result.sessions,
    },
    verdict: result.verdict,
    assertions: result.assertions,
    error: result.error,
    skipReason: result.skipReason,
  };
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
