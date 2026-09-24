/** Types shared by local and remote agent child starts. */

import type { hydrateDurableSession } from "#execution/session.js";
import type {
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";

/** Agent requests that may continue an existing agent via `agentId`. */
export type RuntimeAgentHandleAction =
  | RuntimeRemoteAgentDispatchRequest
  | RuntimeSubagentDispatchRequest;

/** Hydrated parent session snapshot threaded through dispatch. */
export type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

/** Where the owner reaches a remote child it just created. */
export interface RemoteChildAddress {
  readonly callbackBaseUrl: string;
  /** Auth and header resolver selected when the child was created. */
  readonly credentialResolver?: string;
  readonly sessionId: string;
  readonly url: string;
}

/**
 * Outcome of starting one child. A local child reports its own address to
 * the owner once it has claimed it; a remote child's address comes back from
 * the create request.
 */
export type DispatchOutcome =
  | { readonly kind: "started"; readonly remote?: RemoteChildAddress }
  | { readonly kind: "error"; readonly result: RuntimeSubagentDispatchFailure };
