import { CALL_TOOL, SEARCH_TOOL, SKILL_TOOL } from "@eve-e2e/config/catalog-tools";
import type { EveEvalTurn } from "eve/evals";

import { CATALOG_TOOLS } from "../agent/lib/catalog";

type Events = Parameters<Parameters<EveEvalTurn["eventsSatisfy"]>[1]>[0];

/** Entries only the catalog tools reach: the deferred tools, skill, and agent. */
const CATALOG_ENTRIES = new Set([
  ...CATALOG_TOOLS.map(({ name }) => name),
  "support__escalation-policy",
  "account_researcher",
]);

/**
 * The tools the model called, in order. A call through `eve__tool` is reported
 * under the entry it reaches, and an `eve__skill` load as `load-skill`.
 */
export function calledTools(events: Events): string[] {
  return events.flatMap((event) =>
    event.type === "call.requested"
      ? [event.data.capability.kind === "skill" ? "load-skill" : event.data.capability.name]
      : [],
  );
}

/** Whether a called tool belongs to the catalog: a catalog tool, or an entry they reach. */
export function usesCatalog(name: string): boolean {
  return (
    name === SEARCH_TOOL ||
    name === CALL_TOOL ||
    name === SKILL_TOOL ||
    name === "load-skill" ||
    CATALOG_ENTRIES.has(name)
  );
}
