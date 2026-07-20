const INLINE_DIAGNOSTIC_MAX_LINES = 4;
const INLINE_DIAGNOSTIC_MAX_CHARACTERS = 600;
const DIAGNOSTIC_SUMMARY_MAX_CHARACTERS = 240;

export type DiagnosticPresentation =
  | { readonly kind: "inline"; readonly text: string }
  | {
      readonly kind: "stored";
      readonly summary: string;
      readonly omittedLines: number;
      readonly path: string;
    };

/** Chooses whether process diagnostics stay inline or collapse to the local sink. */
export function presentDiagnostic(text: string, path: string): DiagnosticPresentation {
  const lines = text.split("\n");
  if (
    lines.length <= INLINE_DIAGNOSTIC_MAX_LINES &&
    text.length <= INLINE_DIAGNOSTIC_MAX_CHARACTERS
  ) {
    return { kind: "inline", text };
  }

  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "Diagnostic output";
  const summary =
    first.length <= DIAGNOSTIC_SUMMARY_MAX_CHARACTERS
      ? first
      : `${first.slice(0, DIAGNOSTIC_SUMMARY_MAX_CHARACTERS - 1)}…`;
  return {
    kind: "stored",
    summary,
    omittedLines: Math.max(0, lines.length - 1),
    path,
  };
}

export function formatStoredDiagnostic(
  presentation: Extract<DiagnosticPresentation, { kind: "stored" }>,
): string {
  const count = presentation.omittedLines;
  const omitted =
    count === 0 ? "diagnostic details" : `${count} diagnostic line${count === 1 ? "" : "s"}`;
  return `${presentation.summary}\n… ${omitted} · details: ${presentation.path}`;
}
