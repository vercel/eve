import {
  createCliTheme,
  renderCliBanner,
  sanitizeForTerminal,
  type CliTheme,
} from "#cli/ui/output.js";

import type { DoctorResult } from "./doctor.js";
import type { Diagnostic, DiagnosticStatus } from "./types.js";

const SYMBOLS = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;

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

function renderDiagnostic(theme: CliTheme, diagnostic: Diagnostic): string[] {
  return [
    `${statusText(theme, diagnostic.status, SYMBOLS[diagnostic.status])} ${sanitizeForTerminal(diagnostic.summary)}`,
    ...diagnostic.remediation.map((item) =>
      item.kind === "command"
        ? `    ${theme.muted("Run:")} ${theme.info(sanitizeForTerminal(item.command))}`
        : `    ${sanitizeForTerminal(item.message)}`,
    ),
  ];
}

function section(title: string, diagnostics: readonly Diagnostic[], theme: CliTheme): string[] {
  if (diagnostics.length === 0) return [];
  return [
    theme.accent(sanitizeForTerminal(title)),
    ...diagnostics.flatMap((diagnostic) => renderDiagnostic(theme, diagnostic)),
    "",
  ];
}

export function renderDoctorHuman(
  result: DoctorResult,
  theme: CliTheme = createCliTheme(),
): string {
  const environment = result.diagnostics.filter(
    (diagnostic) => diagnostic.id === "runtime.node" || diagnostic.id === "project.discovery",
  );
  const packages = result.diagnostics.filter((diagnostic) => diagnostic.id.startsWith("package."));
  const vercel = result.diagnostics.filter((diagnostic) => diagnostic.id.startsWith("vercel."));
  const git = result.diagnostics.filter((diagnostic) => diagnostic.id.startsWith("git."));
  const agents = result.agents.flatMap((agent) => [
    theme.accent(sanitizeForTerminal(result.scope === "workspace" ? agent.name : "Agent")),
    ...agent.diagnostics.flatMap((diagnostic) => renderDiagnostic(theme, diagnostic)),
    "",
  ]);
  const lines = [
    ...section("Environment", environment, theme),
    ...section("Packages", packages, theme),
    ...section("Vercel", vercel, theme),
    ...(agents.length > 0 ? [theme.accent("Agents"), ...agents] : []),
    ...section("Git", git, theme),
    theme.muted(
      `${result.summary.fail} failures, ${result.summary.warn} warnings, ${result.summary.unknown} unknown`,
    ),
  ];
  return [
    renderCliBanner(theme, {
      subtitle: "Read-only environment, project, and Vercel readiness checks.",
      title: "eve Doctor",
    }),
    "",
    lines.join("\n"),
  ].join("\n");
}

export function renderDoctorJson(result: DoctorResult): string {
  return JSON.stringify(result, null, 2);
}
