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
import {
  SESSION_INBOX_WIRE_VERSION,
  SessionInboxWireError,
} from "#execution/wire/session-inbox-contract.js";
import type { SessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWireV0Migration } from "#execution/wire/session-inbox-wire.v0.js";
import {
  normalizeSessionInboxWireV2,
  sessionInboxWireV1Migration,
} from "#execution/wire/session-inbox-wire.v2-migration.js";

/**
 * The session inbox wire family: every payload persisted to a session's
 * durable inbox hooks crosses through `sessionInboxWire.encode` /
 * `sessionInboxWire.decode`.
 *
 * Historic migrations live in `session-inbox-wire.vN.ts` modules; the
 * current schema and encoder live in the current version module. This file
 * remains the dependency-free decoder facade reached by the workflow body.
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

const sessionInboxMigrations: readonly VersionMigration[] = [
  sessionInboxWireV0Migration,
  sessionInboxWireV1Migration,
];

/**
 * Decodes a persisted inbox payload or throws {@link SessionInboxWireError}.
 *
 * Unknown newer versions and shape mismatches both throw: a lost delivery
 * with an operator-visible signal is the designed failure; a reinterpreted
 * delivery is the bug this module exists to prevent.
 */
function decode(value: unknown): DecodedSessionInbox {
  const declaredVersion =
    typeof value === "object" && value !== null && "version" in value
      ? (value as { readonly version?: unknown }).version
      : undefined;
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

  const wire = normalizeSessionInboxWireV2(migrated) as Partial<SessionInboxWire>;
  if (wire.version !== SESSION_INBOX_WIRE_VERSION) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} declares version ${JSON.stringify(wire.version)}, expected ${SESSION_INBOX_WIRE_VERSION}.`,
    );
  }
  if (declaredVersion === 2 && wire.kind === "deliver" && !("payload" in wire)) {
    throw new SessionInboxWireError(`${WIRE_LABEL} does not match wire version 2.`);
  }
  return normalizeWire(wire as SessionInboxWire);
}

/** Workflow-safe consumer facade. */
export const sessionInboxWire = { decode } as const;

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
