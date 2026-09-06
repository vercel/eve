import type { SessionInboxWireVersion } from "#execution/wire/session-inbox-contract.js";
import type { SessionInboxWireV1 } from "#execution/wire/session-inbox-wire.v1.js";
import type { SessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2.js";
import type { SessionInboxWireV3 } from "#execution/wire/session-inbox-wire.v3.js";
import type { SessionInboxWireV4 } from "#execution/wire/session-inbox-wire.v4.js";
import type { SessionInboxWireV5 } from "#execution/wire/session-inbox-wire.v5.js";
import type { SessionInboxWireV6 } from "#execution/wire/session-inbox-wire.v6.js";

interface WireVersions {
  1: SessionInboxWireV1;
  2: SessionInboxWireV2;
  3: SessionInboxWireV3;
  4: SessionInboxWireV4;
  5: SessionInboxWireV5;
  6: SessionInboxWireV6;
}

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
