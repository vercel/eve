/**
 * Shared shapes for the runtime-action dispatch step: the hydrated parent
 * session snapshot threaded through dispatch, and the per-action outcome
 * every dispatch helper resolves to.
 */

import type { AgentAddress } from "#harness/handles/store.js";
import type { RuntimeSubagentDispatchFailure } from "#runtime/actions/types.js";
import type { hydrateDurableSession } from "#execution/session.js";

/** Hydrated parent session snapshot threaded through dispatch. */
export type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

/**
 * Outcome of dispatching one planned runtime action: an adopted child ready
 * for the `subagent.called` emission tail, or a per-action error result.
 * Either way the (possibly updated) session snapshot rides along.
 *
 * `address` is the same confirmed {@link AgentAddress} recorded on the
 * child's running handle; consumers project it into wire shapes (e.g. the
 * flat `childSessionId` / `remote` fields of `subagent.called`) at the
 * emission site instead of this type re-encoding them.
 */
export type DispatchOutcome =
  | {
      readonly address: AgentAddress;
      readonly callId: string;
      readonly kind: "called";
      readonly name: string;
      readonly session: RuntimeSession;
      readonly toolName: string;
    }
  | {
      readonly kind: "error";
      readonly result: RuntimeSubagentDispatchFailure;
      readonly session: RuntimeSession;
    };
