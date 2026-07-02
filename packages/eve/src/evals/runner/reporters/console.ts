import picocolors from "#compiled/picocolors/index.js";

import type {
  AssertionResult,
  EveEval,
  EveEvalResult,
  EveEvalRunSummary,
  EveEvalTarget,
} from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

/**
 * Console reporter that prints eval progress and results to stdout.
 */
export class ConsoleReporter implements EvalReporter {
  readonly #log: (message: string) => void;
  readonly #colors: ReturnType<typeof picocolors.createColors>;

  constructor(options?: { log?: (message: string) => void; color?: boolean }) {
    this.#log = options?.log ?? console.log;
    this.#colors = picocolors.createColors(options?.color ?? Boolean(process.stdout.isTTY));
  }

  onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): void {
    this.#log("");
    this.#log(
      `${this.#colors.bold(this.#colors.cyan("EVALS"))} ${this.#colors.bold(String(evaluations.length))}`,
    );
    this.#log(
      `${this.#colors.dim("target")} ${target.kind === "local" ? this.#colors.green(target.url) : this.#colors.blue(target.url)}`,
    );
    this.#log("");
  }

  onEvalComplete(result: EveEvalResult): void {
    const { assertions, verdict, error, skipReason } = result;
    const gates = assertions.filter((assertion) => assertion.severity === "gate");
    const softs = assertions.filter((assertion) => assertion.severity === "soft");

    const icon = this.#verdictIcon(verdict);
    const gateText =
      gates.length > 0
        ? this.#formatGateCount(gates.filter((gate) => gate.passed).length, gates.length)
        : "";
    const scoreText = softs
      .map((assertion) => this.#formatScore(assertion.name, assertion.score))
      .join("  ");

    const line = [icon, this.#colors.dim(result.id), gateText, scoreText]
      .filter(Boolean)
      .join("  ");
    this.#log(line);

    for (const assertion of assertions) {
      if (assertion.passed) continue;
      const detail = assertion.message === undefined ? "" : `: ${assertion.message}`;
      this.#log(`  ${this.#colors.red(`✗ ${assertion.name}${detail}`)}`);
    }

    if (error) {
      this.#log(`  ${this.#colors.red(error)}`);
    }
    if (skipReason) {
      this.#log(`  ${this.#colors.dim(skipReason)}`);
    }
  }

  onRunComplete(summary: EveEvalRunSummary): void {
    this.#log("");

    const { passed, failed, scored, skipped, results } = summary;
    const total = results.length;
    const parts: string[] = [];

    if (passed > 0) {
      parts.push(this.#colors.green(`${passed} passed`));
    }
    if (failed > 0) {
      parts.push(this.#colors.red(`${failed} failed`));
    }
    if (scored > 0) {
      parts.push(this.#colors.yellow(`${scored} scored`));
    }
    if (skipped > 0) {
      parts.push(this.#colors.dim(`${skipped} skipped`));
    }
    if (parts.length === 0) {
      parts.push(this.#colors.dim("0 evals"));
    }

    this.#log(
      `${this.#colors.bold("Results:")} ${parts.join(", ")} ${this.#colors.dim(`(${total} total)`)}`,
    );

    const gateTotals = this.#aggregateGates(results);
    if (gateTotals.total > 0) {
      const passedText = this.#colors.green(`${gateTotals.passed} passed`);
      const failedText =
        gateTotals.failed > 0 ? `, ${this.#colors.red(`${gateTotals.failed} failed`)}` : "";
      this.#log(`${this.#colors.bold("Gates:")} ${passedText}${failedText}`);
    }

    const scoreAggregates = this.#aggregateScores(results);
    if (scoreAggregates.length > 0) {
      this.#log("");
      for (const { name, avg, count } of scoreAggregates) {
        const avgText = this.#formatScore(name, avg);
        this.#log(`  ${avgText} ${this.#colors.dim(`(${count} evals)`)}`);
      }
    }

    const duration = computeDurationMs(summary.startedAt, summary.completedAt);
    this.#log("");
    this.#log(this.#colors.dim(`Completed in ${formatDuration(duration)}`));
    this.#log("");
  }

  #verdictIcon(verdict: EveEvalResult["verdict"]): string {
    switch (verdict) {
      case "passed":
        return this.#colors.green("✓");
      case "failed":
        return this.#colors.red("✗");
      case "scored":
        return this.#colors.yellow("○");
      case "skipped":
        return this.#colors.dim("–");
    }
  }

  #formatGateCount(passed: number, total: number): string {
    const label = `gates ${passed}/${total}`;
    return passed === total ? this.#colors.green(label) : this.#colors.red(label);
  }

  #formatScore(name: string, score: number): string {
    const rounded = Math.round(score * 100);
    const label = `${name}: ${rounded}%`;

    if (score === 1) return this.#colors.green(label);
    if (score === 0) return this.#colors.red(label);
    return this.#colors.yellow(label);
  }

  #aggregateGates(results: readonly EveEvalResult[]): {
    passed: number;
    failed: number;
    total: number;
  } {
    let passed = 0;
    let failed = 0;
    for (const result of results) {
      for (const assertion of gatesOf(result)) {
        if (assertion.passed) passed += 1;
        else failed += 1;
      }
    }
    return { passed, failed, total: passed + failed };
  }

  #aggregateScores(
    results: readonly EveEvalResult[],
  ): { name: string; avg: number; count: number }[] {
    const totals = new Map<string, { sum: number; count: number }>();

    for (const result of results) {
      for (const assertion of result.assertions) {
        if (assertion.severity !== "soft") continue;
        const entry = totals.get(assertion.name);
        if (entry) {
          entry.sum += assertion.score;
          entry.count += 1;
        } else {
          totals.set(assertion.name, { sum: assertion.score, count: 1 });
        }
      }
    }

    return [...totals.entries()].map(([name, { sum, count }]) => ({
      name,
      avg: sum / count,
      count,
    }));
  }
}

function gatesOf(result: EveEvalResult): readonly AssertionResult[] {
  return result.assertions.filter((assertion) => assertion.severity === "gate");
}

function computeDurationMs(startedAt: string, completedAt: string): number {
  return new Date(completedAt).getTime() - new Date(startedAt).getTime();
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1_000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}
