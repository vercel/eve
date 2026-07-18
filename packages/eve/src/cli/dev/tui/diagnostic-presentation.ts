const INLINE_DIAGNOSTIC_MAX_LINES = 4;
const INLINE_DIAGNOSTIC_MAX_CHARACTERS = 600;
const DIAGNOSTIC_SUMMARY_MAX_CHARACTERS = 240;

/**
 * A line that names the failure inside a collapsed dump: the pinned
 * `message:` / `name:` fields of a `formatError` object dump, or the
 * `SomeError: …` headline of a raw stack trace.
 */
const ERROR_HEADLINE_PATTERN = /^\s*(?:message|name):\s*\S|^\s*[A-Z][\w$]*Error\b/u;

export type DiagnosticPresentation =
  | { readonly kind: "inline"; readonly text: string }
  | {
      readonly kind: "stored";
      readonly summary: string;
      /** First error-naming line of the collapsed body, when one exists. */
      readonly headline?: string;
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

  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const first = firstIndex === -1 ? "Diagnostic output" : lines[firstIndex]!.trim();
  const headline = lines
    .slice(firstIndex + 1)
    .find((line) => ERROR_HEADLINE_PATTERN.test(line))
    ?.trim();

  const shown = 1 + (headline === undefined ? 0 : 1);
  const presentation: DiagnosticPresentation = {
    kind: "stored",
    summary: clip(first),
    omittedLines: Math.max(0, lines.length - shown),
    path,
  };
  return headline === undefined ? presentation : { ...presentation, headline: clip(headline) };
}

export function formatStoredDiagnostic(
  presentation: Extract<DiagnosticPresentation, { kind: "stored" }>,
): string {
  const count = presentation.omittedLines;
  const omitted =
    count === 0 ? "diagnostic details" : `${count} diagnostic line${count === 1 ? "" : "s"}`;
  const rows = [presentation.summary];
  if (presentation.headline !== undefined) rows.push(presentation.headline);
  rows.push(`… ${omitted} · details: ${presentation.path}`);
  return rows.join("\n");
}

function clip(line: string): string {
  return line.length <= DIAGNOSTIC_SUMMARY_MAX_CHARACTERS
    ? line
    : `${line.slice(0, DIAGNOSTIC_SUMMARY_MAX_CHARACTERS - 1)}…`;
}
