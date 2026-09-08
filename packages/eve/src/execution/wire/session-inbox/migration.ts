import type { SessionInboxWireVersion } from "#execution/wire/session-inbox/session-inbox-contract.js";
import type { WireVersions } from "#execution/wire/session-inbox/generated/versions.js";

export type Wire<V extends SessionInboxWireVersion> = WireVersions[V];

/** A frozen pair of wire contracts; down must reject changes it cannot preserve. */
export interface Migration<
  From extends SessionInboxWireVersion,
  To extends SessionInboxWireVersion,
> {
  readonly from: From;
  readonly to: To;
  up(payload: Wire<From>): Wire<To>;
  down(payload: Wire<To>): Wire<From>;
}
