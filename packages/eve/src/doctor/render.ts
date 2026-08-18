import { createCliTheme, renderCliBanner, type CliTheme } from "#cli/ui/output.js";

import type { DoctorResult } from "./doctor.js";
import type { Diagnostic, DiagnosticStatus } from "./types.js";

const SYMBOLS = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;
const SECTION_TITLES = ["Environment", "Packages", "Git"] as const;

function sectionFor(diagnostic: Diagnostic): (typeof SECTION_TITLES)[number] {
  if (diagnostic.id.startsWith("runtime.") || diagnostic.id.startsWith("project.")) {
    return "Environment";
  }
  if (diagnostic.id.startsWith("package.")) return "Packages";
  return "Git";
}

function statusText(theme: CliTheme, status: DiagnosticStatus, text: string): string {
  switch (status) {
    case "pass":
      return theme.success(text);
    case "warn":
      return theme.warning(text);
    case "fail":
      return theme.danger(text);
    case "unknown":
      return theme.muted(text);
  }
}

function remediationText(theme: CliTheme, diagnostic: Diagnostic): string[] {
  return diagnostic.remediation.map((item) =>
    item.kind === "command"
      ? `    ${theme.muted("Run:")} ${theme.info(item.command)}`
      : `    ${item.message}`,
  );
}

export function renderDoctorHuman(
  result: DoctorResult,
  theme: CliTheme = createCliTheme(),
): string {
  const lines = SECTION_TITLES.flatMap((section) => {
    const diagnostics = result.diagnostics.filter(
      (diagnostic) => sectionFor(diagnostic) === section,
    );
    if (diagnostics.length === 0) return [];
    return [
      theme.accent(section),
      ...diagnostics.flatMap((diagnostic) => [
        `${statusText(theme, diagnostic.status, SYMBOLS[diagnostic.status])} ${diagnostic.summary}`,
        ...remediationText(theme, diagnostic),
      ]),
      "",
    ];
  });
  lines.push(
    theme.muted(
      `${result.summary.fail} failures, ${result.summary.warn} warnings, ${result.summary.unknown} unknown`,
    ),
  );
  return [
    renderCliBanner(theme, {
      subtitle: "Local environment and project checks. No network calls or changes.",
      title: "eve Doctor",
    }),
    "",
    lines.join("\n"),
  ].join("\n");
}

export function renderDoctorJson(result: DoctorResult): string {
  return JSON.stringify(result, null, 2);
}
