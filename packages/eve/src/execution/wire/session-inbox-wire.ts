import type {
  DeliverHookPayload,
  DeliverPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  runMigrationChain,
  type VersionMigration,
} from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";
import {
  SESSION_INBOX_WIRE_VERSION,
  SessionInboxWireError,
} from "#execution/wire/session-inbox-contract.js";
import type { SessionInboxWire } from "#execution/wire/session-inbox-encoder.js";

/**
 * The session inbox wire family: every payload persisted to a session's
 * durable inbox hooks crosses through `encodeSessionCommand` /
 * `decodeSessionInbox`.
 *
 * Versioning follows the repo's durable-wire idioms: `runMigrationChain`
 * walks historic shapes forward (version 0 is the unversioned era, exactly
 * as for turn-workflow input), and the current shape is declared by
 * {@link SESSION_INBOX_V1_FIELDS}. Changing the current shape is a new
 * version with a migration — the frozen contract test makes editing it in
 * place a red diff.
 *
 * The field table is validated against by hand rather than with a schema
 * library: this module is reached from the workflow driver body, whose
 * bundle is self-contained and base64-embedded, so a vendored validator
 * costs several hundred kB there (see research doc). The session snapshot
 * store makes the same call for the same reason.
 *
 * Validation stops at the envelope: `kind`, `version`, and envelope-owned
 * fields are asserted structurally and any undeclared envelope key is
 * stripped, while `DeliverPayload` interiors, `auth`, and `caller` are owned
 * by adapters and other subsystems and cross opaquely (asserted to be
 * objects, nothing more). Deep-validating interiors would turn every adapter
 * field addition into a wire change.
 *
 * See research/session-inbox-wire-schema.md and issue #1765.
 */

/** A persisted inbox payload normalized for consumption; `send` never survives decode. */
export type DecodedSessionInbox =
  | DeliverHookPayload
  | SessionTimeoutHookPayload
  | Extract<SessionCommand, { readonly kind: "cancel" | "clear" | "compact" | "reset" }>;

export { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";

/** Prefixes chain and schema failures alike, so messages read as one voice. */
const WIRE_LABEL = "session inbox payload";

function migrateSessionInboxV0(prior: unknown): Record<string, unknown> & { readonly version: 1 } {
  const value = prior as Record<string, unknown>;
  if (value.kind === "send") return migrateLegacySend(value);

  if (
    value.kind === "deliver" &&
    !(Array.isArray(value.payloads) && value.payloads.every(isObject))
  ) {
    throw new Error("legacy deliver payload has no object-array payloads field.");
  }

  return { ...value, version: 1 };
}

function migrateLegacySend(send: Record<string, unknown>): {
  readonly version: 1;
} & Record<string, unknown> {
  if (!isObject(send.payload)) {
    throw new Error("legacy send command has no object payload field.");
  }
  if (send.delivery !== undefined && !isObject(send.delivery)) {
    throw new Error("legacy send command has a non-object delivery field.");
  }

  return {
    auth: send.auth,
    caller: send.caller,
    deliveryMetadata:
      send.delivery === undefined ? undefined : [{ ...send.delivery, payloadIndex: 0 }],
    kind: "deliver",
    payload: send.payload,
    payloads: [send.payload],
    requestId: send.requestId,
    taskDeliveryId: send.taskDeliveryId,
    turnPolicy: send.turnPolicy,
    version: 1,
  };
}

/**
 * v0 → v1: the unversioned era. Only one shape actually changed — raw
 * `send` commands (persisted by eve 0.30.3–0.30.8; removable once runs
 * created on those versions age out under the 30-day session timeout)
 * become the deliver envelope. Everything else is stamped and left to the
 * schema, which rejects any kind v1 does not define.
 */
const sessionInboxMigrations: readonly VersionMigration[] = [
  {
    from: 0,
    migrate: migrateSessionInboxV0,
    to: 1,
  },
];

/**
 * Decodes a persisted inbox payload or throws {@link SessionInboxWireError}.
 *
 * Unknown newer versions and shape mismatches both throw: a lost delivery
 * with an operator-visible signal is the designed failure; a reinterpreted
 * delivery is the bug this module exists to prevent.
 */
export function decodeSessionInbox(value: unknown): DecodedSessionInbox {
  let migrated: unknown;
  try {
    migrated = runMigrationChain({
      initialVersion: 0,
      label: WIRE_LABEL,
      migrations: sessionInboxMigrations,
      targetVersion: SESSION_INBOX_WIRE_VERSION,
      value,
    });
  } catch (error) {
    throw new SessionInboxWireError(error instanceof Error ? error.message : String(error));
  }

  const wire = migrated as Partial<SessionInboxWire>;
  if (wire.version !== SESSION_INBOX_WIRE_VERSION) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} declares version ${JSON.stringify(wire.version)}, expected ${SESSION_INBOX_WIRE_VERSION}.`,
    );
  }
  return normalizeWire(wire as SessionInboxWire);
}

/** Strips wire-only fields (`version`, the deliver mirror) for consumption. */
function normalizeWire(wire: SessionInboxWire): DecodedSessionInbox {
  switch (wire.kind) {
    case "deliver":
      return {
        auth: wire.auth,
        caller: wire.caller,
        deliveryMetadata: wire.deliveryMetadata,
        kind: "deliver",
        payloads: wire.payloads as readonly DeliverPayload[],
        requestId: wire.requestId,
        taskDeliveryId: wire.taskDeliveryId,
        turnPolicy: wire.turnPolicy,
      };
    case "session-timeout":
      return { kind: "session-timeout" };
    case "clear":
      return { kind: "clear" };
    case "compact":
      return { kind: "compact" };
    case "reset":
      return { kind: "reset", reason: wire.reason };
    case "cancel":
      return { kind: "cancel", taskId: wire.taskId, turnId: wire.turnId };
    default:
      throw new SessionInboxWireError(
        `${WIRE_LABEL} has an unrecognized kind ${JSON.stringify((wire as { kind?: unknown }).kind)}.`,
      );
  }
}
