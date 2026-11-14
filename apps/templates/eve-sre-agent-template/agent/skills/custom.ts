import { defineDynamic } from "eve/skills";
import { resolveCustomSkills } from "#lib/skills/resolver.ts";
import { getCustomSkillStore } from "#lib/skills/store.ts";

/**
 * Custom skills allow you to create personalized instructions that the agent should follow
 * for specific users, or generalized runbooks that can be used in any session. For example:
 * "Create a runbook to follow the next time this incident occurs, following the steps we
 * performed in this incident channel"
 */
export default defineDynamic((ctx) =>
  resolveCustomSkills(ctx.session.auth.current, {
    list(auth, scope) {
      // Persist records, not branded definitions; failed scopes must remain retryable.
      return ctx.memo(
        [
          ctx.turn?.id ?? null,
          scope,
          auth?.authenticator ?? null,
          auth?.issuer ?? null,
          auth?.principalType ?? null,
          auth?.principalId ?? null,
        ],
        () => getCustomSkillStore().list(auth, scope)
      );
    },
  })
);
