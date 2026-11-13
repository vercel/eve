/**
 * Re-warms the SQL database in sandboxes that eve resumed, but only for sessions that
 * query it. Sandbox setup warms new sandboxes; a resumed one starts with an empty cache.
 *
 * @packageDocumentation
 */

import type { Experimental_SandboxSession } from "ai";
import type { HookEvent } from "eve/hooks";
import { defineHook } from "eve/hooks";

import { defineState } from "../../state";
import { prefetchMirror } from "./prefetch";

/* The skill whose queries read the compacted database. */
export const MIRROR_SQL_SKILL = "search_content";

/* Whether this session has loaded the SQL skill, so later turns are likely to query. */
const usesMirrorSql = defineState<boolean>(
  "contentful.mirror-sql-used",
  () => false
);

/* Hosted sandboxes mount the Drive; local sessions have nothing to warm. */
const hosted = () => process.env.VERCEL === "1";

/**
 * Reports whether a model step asks to load the SQL skill.
 *
 * @param event - Actions requested by one model step.
 * @returns True when any requested action loads {@link MIRROR_SQL_SKILL}.
 */
const requestsMirrorSql = (event: HookEvent<"actions.requested">): boolean =>
  event.data.actions.some(
    (action) =>
      action.kind === "load-skill" && action.input.skill === MIRROR_SQL_SKILL
  );

/** The part of the hook context the warm-up needs. */
interface WarmContext {
  getSandbox: () => PromiseLike<Pick<Experimental_SandboxSession, "spawn">>;
}

/**
 * Records SQL use and warms the sandbox when a step loads the SQL skill.
 *
 * @param event - Actions requested by one model step.
 * @param ctx - Context providing the session's sandbox.
 * @remarks SQL is about to run, so waking the sandbox now overlaps the warm-up with the model writing its query.
 */
export const warmOnSkillLoad = async (
  event: HookEvent<"actions.requested">,
  ctx: WarmContext
): Promise<void> => {
  if (!requestsMirrorSql(event)) {
    return;
  }
  usesMirrorSql.update(() => true);
  if (hosted()) {
    await prefetchMirror(await ctx.getSandbox());
  }
};

/**
 * Warms the sandbox at the start of a turn in sessions that have used SQL.
 *
 * @param ctx - Context providing the session's sandbox.
 * @remarks The skill stays in context, so a resumed session will not load it again before querying.
 */
export const warmOnTurnStart = async (ctx: WarmContext): Promise<void> => {
  if (usesMirrorSql.get() && hosted()) {
    await prefetchMirror(await ctx.getSandbox());
  }
};

export default defineHook({
  events: {
    "actions.requested": warmOnSkillLoad,
    "turn.started": (_event, ctx) => warmOnTurnStart(ctx),
  },
});
