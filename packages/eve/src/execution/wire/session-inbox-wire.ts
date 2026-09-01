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
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { normalizeSessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2-migration.js";
import { sessionInboxWireV1Migration } from "#execution/wire/session-inbox-wire.v2.migration.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";
import { sessionInboxWireV2Migration } from "#execution/wire/session-inbox-wire.v3.migration.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";
import { sessionInboxWireV3Migration } from "#execution/wire/session-inbox-wire.v4.migration.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";
import { formatValidationError } from "#runtime/validation.js";

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
  sessionInboxWireV2Migration,
  sessionInboxWireV3Migration,
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
  const hasDeclaredVersion = typeof value === "object" && value !== null && "version" in value;
  if (hasDeclaredVersion && typeof declaredVersion !== "number") {
    throw new SessionInboxWireError(`${WIRE_LABEL}: value has no numeric "version" field.`);
  }
  const normalized = normalizeSessionInboxWireV2(value);
  if (declaredVersion === 1 || declaredVersion === 2 || declaredVersion === 3) {
    const schema =
      declaredVersion === 1
        ? sessionInboxWireV1Schema
        : declaredVersion === 2
          ? sessionInboxWireV2Schema
          : sessionInboxWireV3Schema;
    const declared = schema.safeParse(normalized);
    if (!declared.success) {
      throw new SessionInboxWireError(
        `${WIRE_LABEL} does not match wire version ${declaredVersion}: ${formatValidationError(declared.error)}`,
      );
    }
  }
  let migrated: unknown;
  try {
    migrated = runMigrationChain({
      initialVersion: 0,
      label: WIRE_LABEL,
      migrations: sessionInboxMigrations,
      targetVersion: SESSION_INBOX_WIRE_VERSION,
      value: normalized,
    });
  } catch (error) {
    throw new SessionInboxWireError(error instanceof Error ? error.message : String(error));
  }

  const parsed = sessionInboxWireV4Schema.safeParse(migrated);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} does not match its declared wire contract: ${formatValidationError(parsed.error)}`,
    );
  }
  const wire = parsed.data as SessionInboxWire;
  if (wire.version !== SESSION_INBOX_WIRE_VERSION) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} declares version ${JSON.stringify(wire.version)}, expected ${SESSION_INBOX_WIRE_VERSION}.`,
    );
  }
  if (
    typeof declaredVersion === "number" &&
    declaredVersion >= 2 &&
    wire.kind === "deliver" &&
    !("payload" in wire)
  ) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} does not match wire version ${declaredVersion}.`,
    );
  }
  return normalizeWire(wire);
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
