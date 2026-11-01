import { createLogger } from "#internal/logging.js";
import {
  type CallInput,
  type Contribution,
  type ContributionValues,
  type Draft,
  force,
  type Lazy,
  once,
  type ToolContribution,
  type ToolEntry,
  type ToolTable,
} from "./definition.js";

const log = createLogger("definitions");

/**
 * The call the contributions make, in definition order. What they add is collected; then each
 * arranges the draft the ones before it left, and sees everything collected.
 */
export function draftOf(contributions: readonly Contribution[], call?: CallInput): Draft {
  let draft: Draft = {
    context: once(async () => (await collect(contributions, "context")).flat()),
    record: once(() =>
      call === undefined ? undefined : { historyState: call.historyState, record: call.record },
    ),
    system: once(async () => (await collect(contributions, "system")).flat()),
    tools: once(async () => mergeTools(await collect(contributions, "tools"))),
  };
  for (const { arrange } of contributions) {
    if (arrange === undefined) continue;
    const { context, record, system, tools } = arrange(draft);
    draft = {
      context: context === undefined ? draft.context : once(context),
      record: record === undefined ? draft.record : once(record),
      system: system === undefined ? draft.system : once(system),
      tools: tools === undefined ? draft.tools : once(tools),
    };
  }
  return draft;
}

/** The latest contribution's choice of model: one that answers `undefined` leaves it to those before. */
export async function decideModel(
  contributions: readonly Contribution[],
): Promise<ContributionValues["model"] | undefined> {
  for (let index = contributions.length - 1; index >= 0; index -= 1) {
    const answer = await force(contributions[index]!.model);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

/** One field of every contribution that adds to it, in order: each made before the next. */
async function collect<F extends "context" | "effects" | "system" | "tools">(
  contributions: readonly Contribution[],
  field: F,
): Promise<ContributionValues[F][]> {
  const out: ContributionValues[F][] = [];
  for (const contribution of contributions) {
    const value = await force(contribution[field] as Lazy<ContributionValues[F]> | undefined);
    if (value !== undefined) out.push(value);
  }
  return out;
}

export async function collectEffects(contributions: readonly Contribution[]) {
  return (await collect(contributions, "effects")).flat();
}

/**
 * Tools join by name: two definitions can't take one name, and the first keeps it. A definition
 * that means to replace a tool arranges the draft instead. Connections and skills join.
 */
function mergeTools(added: readonly ToolContribution[]): ToolTable {
  const entries = new Map<string, ToolEntry>();
  for (const { entries: more } of added) {
    for (const [name, entry] of more ?? []) {
      const taken = entries.get(name);
      if (taken !== undefined) {
        log.error(
          `Tool "${name}" from "${entry.source ?? ""}" collides with the one from "${taken.source ?? ""}"; the first keeps it.`,
        );
        continue;
      }
      entries.set(name, entry);
    }
  }
  return {
    connections: added.flatMap(({ connections }) => connections ?? []),
    entries,
    skills: new Map(added.flatMap(({ skills }) => [...(skills ?? [])])),
  };
}
