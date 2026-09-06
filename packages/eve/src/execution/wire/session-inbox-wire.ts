import type {
  DeliverHookPayload,
  DeliverPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { runMigrationChain } from "#execution/durable-session-migrations/chain.js";
import {
  SESSION_INBOX_WIRE_VERSION,
  SessionInboxWireError,
} from "#execution/wire/session-inbox-contract.js";
import type { Wire } from "#execution/session-inbox/migration.js";
import { sessionInboxUpMigrations } from "#execution/session-inbox/migrations.js";
import { upgradeLegacySessionInbox } from "#execution/session-inbox/legacy.js";
import { normalizeSessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2-migration.js";
import { isObject } from "#shared/guards.js";

type SessionInboxWire = Wire<6>;

/**
 * The session inbox wire family: every payload persisted to a session's
 * durable inbox hooks crosses through `sessionInboxWire.encode` /
 * `sessionInboxWire.decode`.
 *
 * Typed adjacent migrations live in `session-inbox/migrations/`. The legacy
 * adapter retains historical transforms for already-persisted raw sends.
 * This decoder stays dependency-free inside the workflow body.
 *
 * See research/session-inbox-wire-schema.md and issue #1765.
 */

/** A persisted inbox payload normalized for consumption; `send` never survives decode. */
export type DecodedSessionInbox =
  | DeliverHookPayload
  | SessionTimeoutHookPayload
  | Extract<SessionCommand, { readonly kind: "cancel" | "clear" | "compact" | "reset" }>;

export { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";

/** Prefixes migration and contract failures alike, so messages read as one voice. */
const WIRE_LABEL = "session inbox payload";

/**
 * Decodes a persisted inbox payload or throws {@link SessionInboxWireError}.
 *
 * Unknown newer versions and migration-bound shape mismatches both throw: a
 * lost delivery with an operator-visible signal is the designed failure; a
 * reinterpreted delivery is the bug this module exists to prevent.
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
  if (
    (declaredVersion === 1 || declaredVersion === 2 || declaredVersion === 3) &&
    containsCurrentTaskMessages(normalized)
  ) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} does not match wire version ${declaredVersion}.`,
    );
  }
  if (
    typeof declaredVersion === "number" &&
    declaredVersion < 6 &&
    isObject(normalized) &&
    normalized.kind === "cancel" &&
    "tasks" in normalized
  ) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} does not match wire version ${declaredVersion}.`,
    );
  }
  let migrated: unknown;
  try {
    migrated = runMigrationChain({
      initialVersion: 0,
      label: WIRE_LABEL,
      migrations: sessionInboxUpMigrations,
      targetVersion: SESSION_INBOX_WIRE_VERSION,
      value:
        !hasDeclaredVersion || declaredVersion === 0
          ? upgradeLegacySessionInbox(normalized)
          : normalized,
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
  return normalizeWire(wire as SessionInboxWire);
}

/** Workflow-safe consumer facade. */
export const sessionInboxWire = { decode } as const;

function containsCurrentTaskMessages(value: unknown): boolean {
  if (!isObject(value) || value.kind !== "deliver") return false;
  const payloads = Array.isArray(value.payloads) ? value.payloads : [];
  return payloads.some((payload) => {
    if (!isObject(payload) || !isObject(payload.task)) return false;
    if (Object.hasOwn(payload.task, "agentRequests")) return true;
    const inputRequests = payload.task.inputRequests;
    return (
      Array.isArray(inputRequests) &&
      inputRequests.some(
        (request) => isObject(request) && ("request" in request || "requests" in request),
      )
    );
  });
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
      return { kind: "cancel", taskId: wire.taskId, tasks: wire.tasks, turnId: wire.turnId };
    default:
      throw new SessionInboxWireError(
        `${WIRE_LABEL} has an unrecognized kind ${JSON.stringify((wire as { kind?: unknown }).kind)}.`,
      );
  }
}
