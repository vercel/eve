import { fact } from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { commitOf } from "./commit.js";

// The child family's commits: a session a call's run opened, and a message the run sent it.

type Scope = { readonly turnId: string; readonly taskId?: string | undefined };

/** A session a call's run opened, and the route that serves its stream. */
export function openChild(data: FactOf<"child.opened">["data"], scope: Scope): Commit {
  return commitOf([{ ...fact("child.opened", data), scope: scoped(scope) }]);
}

/** A message a call's run sent the session it opened. */
export function recordChildSent(data: FactOf<"child.sent">["data"], scope: Scope): Commit {
  return commitOf([{ ...fact("child.sent", data), scope: scoped(scope) }]);
}

function scoped(scope: Scope): Scope {
  return scope.taskId === undefined
    ? { turnId: scope.turnId }
    : { turnId: scope.turnId, taskId: scope.taskId };
}
