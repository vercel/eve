import { defineDynamic } from "eve/skills";
import { resolveCustomSkills } from "#lib/skills/resolver.ts";

/**
 * Custom skills allow you to create personalized instructions that the agent should follow
 * for specific users, or generalized runbooks that can be used in any session. For example:
 * "Create a runbook to follow the next time this incident occurs, following the steps we
 * performed in this incident channel"
 */
export default defineDynamic((ctx) =>
  ctx.memo(ctx.turn?.id ?? ctx.session.id, () =>
    resolveCustomSkills(ctx.session.auth.current)
  )
);
