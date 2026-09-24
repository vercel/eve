import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type {
  RegistrySessionOutcome,
  RegistrySessionResult,
} from "#setup/flows/registry-session.js";

import type { CommandResultStatus } from "./runner.js";

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

export interface RegistryCommandOutcome {
  status: CommandResultStatus;
  /** Replaces the echoed `/add` once it settles. */
  summary: string;
  /** Detail hung under the summary; empty when the summary says it all. */
  message: string;
}

function outcomeDetails(outcome: RegistrySessionOutcome): string[] {
  switch (outcome.kind) {
    case "installed": {
      const labeledFacts = outcome.facts.filter((fact) => fact.label.length > 0);
      const width = Math.max(0, ...labeledFacts.map((fact) => fact.label.length));
      return [
        ...outcome.facts.map((fact) =>
          fact.label.length === 0 ? fact.value : `${fact.label.padEnd(width)}  ${fact.value}`,
        ),
        ...outcome.output,
      ];
    }
    case "incomplete":
      return [`Finish with \`${outcome.resumeCommand}\``];
    case "failed":
      return outcome.message.replace(" Try again with `", "\nTry again with `").split("\n");
    case "cancelled":
      return [];
  }
}

/** The one-line record of an `/add` item left in place of its invocation. */
export function registryOutcomeSummary(outcome: RegistrySessionOutcome): string {
  switch (outcome.kind) {
    case "installed":
      return `Added ${outcome.title}`;
    case "incomplete":
      return `Added ${outcome.title} · setup not finished`;
    case "failed":
      return `Couldn't add ${outcome.title}`;
    case "cancelled":
      return `${outcome.title} not added`;
  }
}

function outcomeStatus(outcomes: readonly RegistrySessionOutcome[]): CommandResultStatus {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return "error";
  if (outcomes.every((outcome) => outcome.kind === "installed")) return "success";
  return "neutral";
}

/**
 * Summarizes an `/add` session in place of its echoed command. One item folds
 * into the summary itself; several items list one marked row each.
 */
export function registryCommandOutcome(
  result: RegistrySessionResult,
  notes: readonly string[] = [],
): RegistryCommandOutcome {
  const { outcomes } = result;
  const added = outcomes.filter(
    (outcome) => outcome.kind === "installed" || outcome.kind === "incomplete",
  ).length;
  const summary =
    outcomes.length === 1
      ? registryOutcomeSummary(outcomes[0]!)
      : `Added ${added} of ${outcomes.length} items`;
  const lines =
    outcomes.length === 1
      ? outcomeDetails(outcomes[0]!)
      : outcomes.flatMap((outcome) => [
          `* ${registryOutcomeSummary(outcome)}`,
          ...outcomeDetails(outcome).map((line) => `  ${line}`),
        ]);
  lines.push(...notes.map((note) => `⚠ ${note}`));
  return { status: outcomeStatus(outcomes), summary, message: lines.join("\n") };
}
