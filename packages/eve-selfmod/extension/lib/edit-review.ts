export type SourceChange = readonly [path: string, before: string | null, after: string | null];

/** Formats complete before/after file contents for approval review. */
export function formatSourceChanges(changes: readonly SourceChange[]): string {
  return changes
    .map(([path, before, after]) => {
      const beforeLabel = before === null ? "/dev/null" : path;
      const afterLabel = after === null ? "/dev/null" : path;
      return [
        `--- ${beforeLabel}`,
        `+++ ${afterLabel}`,
        ...(before === null ? [] : formatFileContent(before, "-")),
        ...(after === null ? [] : formatFileContent(after, "+")),
      ].join("\n");
    })
    .join("\n\n");
}

function formatFileContent(content: string, prefix: "-" | "+"): string[] {
  const lines = content.split(/\r\n|[\r\n]/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => `${prefix} ${line}`);
}
