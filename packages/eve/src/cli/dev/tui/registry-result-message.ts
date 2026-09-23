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
  /** Detail hung under the echoed `/add`; empty when the gutter says it all. */
  message: string;
}

const OUTCOME_MARKER = {
  installed: "✓",
  incomplete: "–",
  failed: "⨯",
  cancelled: "–",
} as const;

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
      return ["Setup not finished", `Finish with \`${outcome.resumeCommand}\``];
    case "failed":
      return outcome.message.replace(" Try again with `", "\nTry again with `").split("\n");
    case "cancelled":
      return [];
  }
}

function outcomeStatus(outcomes: readonly RegistrySessionOutcome[]): CommandResultStatus {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return "error";
  if (outcomes.every((outcome) => outcome.kind === "installed")) return "success";
  return "cancelled";
}

/**
 * Summarizes an `/add` session for the echoed command: the gutter carries the
 * outcome, so one item only adds its details, and several items list one
 * marked row each.
 */
export function registryCommandOutcome(
  result: RegistrySessionResult,
  notes: readonly string[] = [],
): RegistryCommandOutcome {
  const { outcomes } = result;
  const lines =
    outcomes.length === 1
      ? outcomeDetails(outcomes[0]!)
      : outcomes.flatMap((outcome) => [
          `${OUTCOME_MARKER[outcome.kind]} ${outcome.title}`,
          ...outcomeDetails(outcome).map((line) => `  ${line}`),
        ]);
  lines.push(...notes.map((note) => `⚠ ${note}`));
  return { status: outcomeStatus(outcomes), message: lines.join("\n") };
}
