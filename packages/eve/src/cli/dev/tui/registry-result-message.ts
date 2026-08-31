import type {
  RegistrySessionItemFailure,
  RegistrySessionItemResult,
} from "#setup/flows/registry-session.js";

export type RegistryResultReport = {
  items: readonly RegistrySessionItemResult[];
  failures?: readonly RegistrySessionItemFailure[];
};

export type RegistryResultReportEntry = {
  title: string;
  status: "success" | "error";
  lines: readonly string[];
  detail?: string;
};

export function registryResultReportEntries(
  result: RegistryResultReport,
): readonly RegistryResultReportEntry[] {
  return [
    ...result.items.map((item) => ({
      title: item.title,
      status: "success" as const,
      lines: [...item.facts.map((fact) => `${fact.label}  ${fact.value}`), ...item.output],
    })),
    ...(result.failures ?? []).map((failure) => ({
      title: failure.title,
      status: "error" as const,
      lines: [failure.message],
      detail: failure.detail,
    })),
  ];
}

function joinedTitles(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0]!;
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles.at(-1)}`;
}

/** Formats structured registry setup results after their temporary panel closes. */
export function formatRegistrySessionResult(result: RegistryResultReport): string {
  const lines: string[] = [];
  if (result.items.length > 0)
    lines.push(`Added ${joinedTitles(result.items.map((item) => item.title))}`);
  for (const item of result.items) {
    if (item.facts.length === 0 && item.output.length === 0) continue;
    lines.push("", item.title);
    const width = Math.max(0, ...item.facts.map((fact) => fact.label.length));
    for (const fact of item.facts) lines.push(`  ${fact.label.padEnd(width)}  ${fact.value}`);
    for (const output of item.output) lines.push(`  ${output}`);
  }
  for (const failure of result.failures ?? []) {
    lines.push("", `Couldn't add ${failure.title}`, `  ${failure.message}`);
    if (failure.detail !== failure.message) lines.push(`  ${failure.detail}`);
  }
  return lines.join("\n");
}
