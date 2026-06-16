import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EveEvalResult, EveEvalRunSummary } from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

export interface JUnitReporterConfig {
  readonly filePath: string;
  readonly suiteName?: string;
}

/**
 * Creates a reporter that writes one JUnit XML testsuite for an eval run.
 * Each eval becomes one `<testcase>` named by its path-derived id.
 */
export function JUnit(config: JUnitReporterConfig): EvalReporter {
  return new JUnitReporter(config);
}

class JUnitReporter implements EvalReporter {
  readonly #config: JUnitReporterConfig;

  constructor(config: JUnitReporterConfig) {
    this.#config = config;
  }

  onRunStart(): void {
    // Nothing to initialize.
  }

  onEvalComplete(): void {
    // The file is written once on completion so the suite has final counters.
  }

  async onRunComplete(summary: EveEvalRunSummary): Promise<void> {
    const xml = renderJUnit(summary, { suiteName: this.#config.suiteName });
    await mkdir(dirname(this.#config.filePath), { recursive: true });
    await writeFile(this.#config.filePath, xml);
  }
}

function renderJUnit(summary: EveEvalRunSummary, input: { readonly suiteName?: string }): string {
  const failures = summary.failed + summary.scored;
  const cases = summary.results.map(renderTestCase);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(input.suiteName ?? "eve evals")}" tests="${summary.results.length}" failures="${failures}" skipped="0" time="${formatSeconds(durationSeconds(summary))}">`,
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}

function renderTestCase(result: EveEvalResult): string {
  const attrs = `classname="eve.eval" name="${escapeXml(result.id)}" time="${formatSeconds(durationSeconds(result))}"`;

  if (result.verdict === "passed") {
    return `  <testcase ${attrs}/>`;
  }

  const message = failureMessage(result);
  return [
    `  <testcase ${attrs}>`,
    `    <failure message="${escapeXml(message)}">${escapeXml(JSON.stringify(buildFailureDetail(result), null, 2))}</failure>`,
    "  </testcase>",
  ].join("\n");
}

/**
 * Compact failure payload for the XML body. Full event streams stay in the
 * `.eve/evals/` artifacts; CI annotations only need the verdict and why.
 */
function buildFailureDetail(result: EveEvalResult): Record<string, unknown> {
  return {
    verdict: result.verdict,
    error: result.error,
    assertions: result.assertions,
    logs: result.result.logs,
  };
}

function failureMessage(result: EveEvalResult): string {
  if (result.error !== undefined) return result.error;
  const failed = result.assertions.find((assertion) => !assertion.passed);
  if (failed !== undefined) {
    return failed.message === undefined ? failed.name : `${failed.name}: ${failed.message}`;
  }
  if (result.verdict === "scored") return "score below threshold";
  return result.verdict;
}

function durationSeconds(timed: {
  readonly startedAt: string;
  readonly completedAt: string;
}): number {
  const ms = new Date(timed.completedAt).getTime() - new Date(timed.startedAt).getTime();
  return Math.max(0, ms / 1_000);
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
