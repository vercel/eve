import type { CatalogSkill } from "#execution/catalog/skills.js";
import type { Announcement } from "#harness/announcements.js";
import { createLogger } from "#internal/logging.js";
import {
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
export function draftOf(contributions: readonly Contribution[]): Draft {
  let draft: Draft = {
    announcements: once(async () => announcementsOf(await collect(contributions, "announcements"))),
    context: once(async () => (await collect(contributions, "context")).flat()),
    system: once(async () => (await collect(contributions, "system")).flat()),
    tools: once(async () => mergeTools(await collect(contributions, "tools"))),
  };
  for (const { arrange } of contributions) {
    if (arrange === undefined) continue;
    const { announcements, context, system, tools } = arrange(draft);
    draft = {
      announcements: announcements === undefined ? draft.announcements : once(announcements),
      context: context === undefined ? draft.context : once(context),
      system: system === undefined ? draft.system : once(system),
      tools: tools === undefined ? draft.tools : once(tools),
    };
  }
  return draft;
}

/**
 * The latest contribution's choice of model: one that answers `undefined` leaves it to those before.
 * One that arranges the model wraps the choice of those before it. Each is asked only if needed.
 */
export async function decideModel(
  contributions: readonly Contribution[],
): Promise<ContributionValues["model"] | undefined> {
  let decided: () => Promise<ContributionValues["model"] | undefined> = async () => undefined;
  for (const contribution of contributions) {
    const before = decided;
    if (contribution.arrangeModel !== undefined) {
      const arrange = contribution.arrangeModel;
      decided = once(() => arrange(before));
    } else if (contribution.model !== undefined) {
      const model = contribution.model;
      decided = once(async () => (await force(model)) ?? (await before()));
    }
  }
  return await decided();
}

/** One field of every contribution that adds to it, in order: each made before the next. */
async function collect<F extends "announcements" | "context" | "effects" | "system" | "tools">(
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
 * Tools and skills join by name: two definitions can't take one name, and the first keeps it. A
 * definition that means to replace a tool arranges the draft instead. Connections join.
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
  const skills = new Map<string, CatalogSkill>();
  for (const { skills: more } of added) {
    for (const [name, skill] of more ?? []) {
      const taken = skills.get(name);
      if (taken === undefined) skills.set(name, skill);
      // The agent's own skills join last, so a dynamic skill keeps a name they share, quietly.
      else if (skill.source !== undefined) {
        log.error(
          `Skill "${name}" from "${skill.source}" collides with the one from "${taken.source ?? ""}"; the first keeps it.`,
        );
      }
    }
  }
  return {
    connections: added.flatMap(({ connections }) => connections ?? []),
    entries,
    skills,
  };
}

/** Announcements by key: two definitions can't announce under one key, and the first keeps it. */
function announcementsOf(
  added: readonly Readonly<Record<string, Announcement>>[],
): Readonly<Record<string, Announcement>> {
  const keys = new Set<string>();
  return Object.fromEntries(
    added.flatMap((announcements) =>
      Object.entries(announcements).filter(([key]) => claim(keys, key, "announcement")),
    ),
  );
}

function claim(taken: Set<string>, name: string, kind: string): boolean {
  if (!taken.has(name)) {
    taken.add(name);
    return true;
  }
  log.error(`Two definitions make the ${kind} "${name}"; the first keeps it.`);
  return false;
}
