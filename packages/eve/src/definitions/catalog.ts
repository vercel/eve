import type { OfferedCatalogTools } from "#context/keys.js";
import { catalogReach, catalogTools } from "#execution/catalog/catalog-tools.js";
import { catalogAnnouncements } from "#execution/catalog/listing.js";
import { type Callable, callableOf } from "#execution/catalog/step-catalog.js";
import { dynamicSkillAnnouncements } from "#execution/skills/instructions.js";
import { type Definition, type DefinitionContext, once } from "./definition.js";

/**
 * eve's catalog tools, `eve__search`, `eve__tool`, and `eve__skill`, each where what the step can
 * run reaches it, after every tool of the step's. `eve__search` announces what the catalog holds,
 * and `eve__skill` the dynamic skills. It arranges: what it adds reads every tool before it.
 */
export const catalog: Definition = {
  contribute: (ctx) => {
    const { step } = ctx;
    if (step === undefined) return {};
    return {
      arrange: (draft) => {
        const reached = once(async () => {
          const table = await draft.tools();
          const callable = callableOf({
            ctx: ctx.container,
            endsTurn: step.endsTurn,
            session: step.session,
            table,
          });
          return { callable, offered: await offered(ctx, callable), table };
        });
        return {
          tools: async () => {
            const { callable, offered, table } = await reached();
            const added = [
              ...catalogTools(callable, offered, {
                catalog: catalogAnnouncements(callable),
                skills: dynamicSkillAnnouncements(
                  [...callable.skills.values()].filter(({ source }) => source !== undefined),
                ),
              }),
            ].filter(([name]) => !table.entries.has(name));
            return { ...table, entries: new Map([...table.entries, ...added]) };
          },
        };
      },
    };
  },
  id: "eve.catalog",
  label: "eve's catalog tools",
};

/**
 * The catalog tools the step offers: what it reaches, and every one the session was offered
 * before, so the tool list changes at most once for each and never drops one that earlier calls
 * named. Before each model call eve keeps what it offers; other steps only read it.
 */
async function offered(ctx: DefinitionContext, callable: Callable): Promise<OfferedCatalogTools> {
  const reach = catalogReach(callable);
  const kept = await ctx.keep((_evaluation, previous) => {
    const offered = union(reach, previous as OfferedCatalogTools | null | undefined);
    return Object.values(offered).includes(true) ? { value: { ...offered } } : null;
  });
  return union(reach, kept?.value as OfferedCatalogTools | null | undefined);
}

function union(
  reach: OfferedCatalogTools,
  before: OfferedCatalogTools | null | undefined,
): OfferedCatalogTools {
  return {
    connections: reach.connections || before?.connections === true,
    searchableSkills: reach.searchableSkills || before?.searchableSkills === true,
    skills: reach.skills || before?.skills === true,
    tools: reach.tools || before?.tools === true,
  };
}
