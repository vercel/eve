/**
 * Runtime context helpers for authored code.
 *
 * These APIs work only inside active authored runtime execution such as
 * tools and other eve-invoked callbacks.
 *
 * @example
 * ```ts
 * import { defineState } from "eve/context";
 * ```
 */

export type {
  Session,
  SessionAuth,
  SessionAuthContext,
  SessionParent,
  SessionTurn,
} from "#context/accessors.js";
export { defineState, type StateHandle } from "#public/definitions/state.js";
export type { SessionContext } from "#public/definitions/callback-context.js";
