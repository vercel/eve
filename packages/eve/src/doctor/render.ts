import type { DoctorResult } from "./doctor.js";
import type { Diagnostic } from "./types.js";

const SYMBOLS = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;

function remediationText(diagnostic: Diagnostic): string[] {
  return diagnostic.remediation.map((item) =>
    item.kind === "command" ? `    Run: ${item.command}` : `    ${item.message}`,
  );
}

export function renderDoctorHuman(result: DoctorResult): string {
  const lines = [
    ...result.diagnostics.flatMap((diagnostic) => [
      `${SYMBOLS[diagnostic.status]} ${diagnostic.summary}`,
      ...remediationText(diagnostic),
    ]),
    "",
    `${result.summary.fail} failures, ${result.summary.warn} warnings, ${result.summary.unknown} unknown`,
  ];
  return lines.join("\n");
}

export function renderDoctorJson(result: DoctorResult): string {
  return JSON.stringify(result, null, 2);
}
