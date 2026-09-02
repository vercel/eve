import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type { RegistrySessionResult } from "#setup/flows/registry-session.js";

/** Builds the shared transient progress update for `/add` and initial onboarding. */
export function registryItemProgress(renderer: {
  replaceContent?(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void;
  setNavigation?(navigation: undefined): void;
  setStatus(status: string | undefined): void;
}): (item: RegistryCatalogItem, index: number, total: number) => void {
  return (item, index, total) => {
    renderer.setNavigation?.(undefined);
    renderer.replaceContent?.();
    renderer.setStatus(`Adding ${item.title ?? item.name} · ${index + 1} of ${total}`);
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

function resultHeadline(
  outcomes: readonly { kind: "installed" | "failed" | "cancelled" }[],
  installedTitles: readonly string[],
): string {
  const failed = outcomes.filter((outcome) => outcome.kind === "failed").length;
  const cancelled = outcomes.filter((outcome) => outcome.kind === "cancelled").length;
  if (failed === 0 && cancelled === 0) return `Added ${joinedTitles(installedTitles)}`;

  const installed = outcomes.length - failed - cancelled;
  const parts = [
    installed > 0 ? `${installed} added` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    cancelled > 0 ? `${cancelled} cancelled` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${outcomes.length} ${outcomes.length === 1 ? "addition" : "additions"}: ${parts.join(", ")}`;
}

/** Formats structured registry setup results after their temporary panel closes. */
export function formatRegistrySessionResult(result: RegistrySessionResult): string {
  const outcomes = result.outcomes ?? [
    ...result.items.map((item) => ({ kind: "installed" as const, ...item })),
    ...result.failures.map((failure) => ({ kind: "failed" as const, ...failure })),
  ];
  const lines = [
    resultHeadline(
      outcomes,
      result.items.map((item) => item.title),
    ),
  ];
  for (const outcome of outcomes) {
    const marker = outcome.kind === "installed" ? "✓" : outcome.kind === "failed" ? "⨯" : "–";
    lines.push("", `  ${marker} ${outcome.title}`);
    if (outcome.kind === "cancelled") {
      lines.push("    Cancelled.");
      continue;
    }
    if (outcome.kind === "failed") {
      lines.push(...outcome.message.split("\n").map((line) => `    ${line}`));
      continue;
    }
    if (outcome.facts.length === 0 && outcome.output.length === 0) {
      lines.push("    Installed.");
      continue;
    }
    const width = Math.max(0, ...outcome.facts.map((fact) => fact.label.length));
    for (const fact of outcome.facts) lines.push(`    ${fact.label.padEnd(width)}  ${fact.value}`);
    for (const output of outcome.output) lines.push(`    ${output}`);
  }
  if (result.cancelled === true) {
    lines.push("", "Setup stopped before the remaining selections were added.");
  }
  return lines.join("\n");
}
