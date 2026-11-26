import type { SessionAuthContext } from "eve/context";

/** Operation passed to {@link BoardAuthorize}. */
export type BoardAuthorizeAction = "watch" | "watches" | "unwatch" | "settle_task";

/** Context passed to `authorize` before creating, listing, or removing board watches, or settling a task by its ID. */
export interface BoardAuthorizeRequest {
  /** Which operation is being requested. */
  readonly action: BoardAuthorizeAction;
  /** The session's current caller, or `null` when the session has none. */
  readonly auth: SessionAuthContext | null;
  /** The configured board key (or `"default"` for a shorthand mount). */
  readonly board: string;
  /** The board's configured name, when set. */
  readonly boardName?: string;
  /** The board's configured team, when set. */
  readonly team?: string;
  /** For `"watch"`, the channel selector being watched. */
  readonly channel?: string;
  /** For `"watch"` with `claim`, the task queue channel selector being claimed from. */
  readonly claimChannel?: string;
  /** For `"unwatch"`, the watch ID being removed. */
  readonly watchId?: string;
  /** For `"settle_task"`, the ID of the task being settled. */
  readonly taskId?: string;
}

/**
 * Decides whether the current caller may create, list, or remove watches on a board, or settle
 * a task by its ID.
 * Return `true` to allow the operation; any other value denies it.
 */
export type BoardAuthorize = (request: BoardAuthorizeRequest) => boolean | Promise<boolean>;
