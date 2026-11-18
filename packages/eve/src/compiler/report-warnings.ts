import type { CompilerDiagnostic } from "#compiler/diagnostics.js";

export function reportDiscoverWarnings(diagnostics: readonly CompilerDiagnostic[]): void {
  for (const warning of diagnostics) {
    if (warning.severity !== "warning") continue;
    console.warn(
      `Warning [${warning.code}]: ${warning.message}\n  source: ${formatDiagnosticSources(warning)}`,
    );
  }
}

export function formatDiagnosticSources(diagnostic: CompilerDiagnostic): string {
  return diagnostic.sources
    .map((source) => source.sourcePath ?? source.logicalPath ?? source.sourceId ?? source.nodeId)
    .join(", ");
}
