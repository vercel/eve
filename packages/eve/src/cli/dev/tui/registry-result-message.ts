import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type { RegistrySessionResult } from "#setup/flows/registry-session.js";

/** Builds the shared transient progress update for `/add` and initial onboarding. */
export function registryItemProgress(renderer: {
  replaceContent?(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void;
  setStatus(status: string | undefined): void;
}): (item: RegistryCatalogItem, index: number, total: number) => void {
  return (item, index, total) => {
    renderer.replaceContent?.({
      headline: `Adding ${item.title ?? item.name} · ${index + 1} of ${total}`,
      facts: [],
    });
    renderer.setStatus("Installing files and dependencies…");
  };
}

export function registryResultTone(result: RegistrySessionResult): "success" | "error" | undefined {
  if (result.failures.length > 0 && result.items.length === 0) return "error";
  if (result.outcomes?.some((outcome) => outcome.kind === "cancelled")) return undefined;
  return result.items.length > 0 ? "success" : undefined;
}

function joinedTitles(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0]!;
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles.at(-1)}`;
}

/** Formats structured registry setup results after their temporary panel closes. */
export function formatRegistrySessionResult(result: RegistrySessionResult): string {
  const lines: string[] = [];
  const outcomes = result.outcomes ?? [
    ...result.items.map((item) => ({ kind: "installed" as const, ...item })),
    ...result.failures.map((failure) => ({ kind: "failed" as const, ...failure })),
  ];
  if (result.items.length > 0) {
    lines.push(`Added ${joinedTitles(result.items.map((item) => item.title))}`);
  }
  for (const outcome of outcomes) {
    lines.push("", `${outcome.kind === "installed" ? "✓" : "⨯"} ${outcome.title}`);
    if (outcome.kind === "cancelled") {
      lines.push("  Cancelled.");
      continue;
    }
    if (outcome.kind === "failed") {
      lines.push(...outcome.message.split("\n").map((line) => `  ${line}`));
      continue;
    }
    if (outcome.facts.length === 0 && outcome.output.length === 0) {
      lines.push("  Installed.");
      continue;
    }
    const width = Math.max(0, ...outcome.facts.map((fact) => fact.label.length));
    for (const fact of outcome.facts) lines.push(`  ${fact.label.padEnd(width)}  ${fact.value}`);
    for (const output of outcome.output) lines.push(`  ${output}`);
  }
  if (result.cancelled === true) {
    lines.push("", "Setup cancelled before the remaining selections were added.");
  }
  return lines.join("\n");
}
