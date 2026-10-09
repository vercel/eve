import { truncateDiagnostic } from "#evals/diagnostics.js";
import type { AssertionResult } from "#evals/types.js";

const MAX_DETAIL_LINE_LENGTH = 240;
const MAX_DETAIL_LINES = 4;

export function formatAssertionFailureHeadline(assertion: AssertionResult): string {
  const comparison =
    assertion.threshold === undefined || assertion.score === undefined
      ? ""
      : ` (${formatPercent(assertion.score)} < ${formatPercent(assertion.threshold)})`;
  const [headline] = assertion.message?.split("\n") ?? [];
  const detail =
    headline === undefined ? "" : `: ${truncateDiagnostic(headline, MAX_DETAIL_LINE_LENGTH)}`;
  return `${assertion.name}${comparison}${detail}`;
}

export function formatAssertionFailureDetailLines(assertion: AssertionResult): readonly string[] {
  const [, ...lines] = assertion.message?.split("\n") ?? [];
  const visible = lines
    .slice(0, MAX_DETAIL_LINES)
    .map((line) => truncateDiagnostic(line, MAX_DETAIL_LINE_LENGTH));
  return lines.length > MAX_DETAIL_LINES ? [...visible, "…"] : visible;
}

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
