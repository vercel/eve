import { defineHook } from "eve/hooks";

import {
  conflictsWithThreadRoles,
  recordThreadRole,
  ROLE_SCOPED_TOOLS,
} from "#lib/analyst/thread-roles";

/**
 * Keeps one Slack thread's query results with the role that fetched them.
 *
 * @remarks Each successful `run_sql` or `describe_schema` result records the caller's role. A later turn whose caller resolves to a different role, or to no access, is cancelled before the model runs, and the Slack renderer asks that person to start a new thread. Callers who share a role, including `local-dev`, are never blocked.
 */
export default defineHook({
  events: {
    "action.result"(event, ctx) {
      const { result, status } = event.data;
      if (
        status !== "completed" ||
        result.kind !== "tool-result" ||
        result.isError === true ||
        !ROLE_SCOPED_TOOLS.has(result.toolName)
      ) {
        return;
      }
      recordThreadRole(ctx.session.auth.current);
    },
    "turn.started"(_event, ctx) {
      if (conflictsWithThreadRoles(ctx.session.auth.current)) {
        ctx.cancel();
      }
    },
  },
});
