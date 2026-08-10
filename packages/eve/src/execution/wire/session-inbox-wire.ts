import { z } from "#compiled/zod/index.js";

import type {
  ChannelDeliveryMetadataEntry,
  DeliverHookPayload,
  DeliverPayload,
  SessionAuthContext,
  SessionCommand,
  SessionTimeoutHookPayload,
  TurnCaller,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  runMigrationChain,
  type VersionMigration,
} from "#execution/durable-session-migrations/chain.js";
import { formatValidationError } from "#runtime/validation.js";

/**
 * The session inbox wire family: every payload persisted to a session's
 * durable inbox hooks crosses through `encodeSessionCommand` /
 * `decodeSessionInbox`.
 *
 * Versioning follows the repo's durable-wire idioms: `runMigrationChain`
 * walks historic shapes forward (version 0 is the unversioned era, exactly
 * as for turn-workflow input), and the current shape is validated with a
 * `version: z.literal(...)` schema plus a named error class, exactly as the
 * compiled-artifact loaders do. Changing the current shape is a new version
 * with a migration — the frozen contract test makes editing it in place a
 * red diff.
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

export const SESSION_INBOX_WIRE_VERSION = 1;

type SendCommand = Extract<SessionCommand, { readonly kind: "send" }>;

/** A persisted inbox payload normalized for consumption; `send` never survives decode. */
export type DecodedSessionInbox =
  | DeliverHookPayload
  | SessionTimeoutHookPayload
  | Extract<SessionCommand, { readonly kind: "cancel" | "clear" | "compact" | "reset" }>;

/** Raised for payloads a consumer must not reinterpret. */
export class SessionInboxWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInboxWireError";
  }
}

/** Prefixes chain and schema failures alike, so messages read as one voice. */
const WIRE_LABEL = "session inbox payload";

function isOpaqueObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

const deliverPayload = z.custom<DeliverPayload>(isOpaqueObject);
const deliveryMetadata = z.custom<ChannelDeliveryMetadataEntry>(isOpaqueObject);
const version = z.literal(SESSION_INBOX_WIRE_VERSION);
const deliverFields = {
  auth: z.custom<SessionAuthContext>(isOpaqueObject).nullable().optional(),
  caller: z.custom<TurnCaller>(isOpaqueObject).optional(),
  deliveryMetadata: z.array(deliveryMetadata).optional(),
  requestId: z.string().optional(),
  taskDeliveryId: z.string().optional(),
  turnPolicy: z.enum(["queue", "steer"]).optional(),
  version,
};

/**
 * v1, the current wire shape. The deliver `payload` mirror is transitional:
 * consumers pinned to eve 0.30.3–0.30.8 cast any non-control payload to a
 * `send` command and read `.payload`, so the mirror is what keeps their
 * parked sessions receiving messages. Sessions are bounded by the 30-day
 * default timeout; the version after this drops the mirror once runs
 * created on those versions have aged out.
 */
export const sessionInboxWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deliver"),
    payload: deliverPayload.optional(),
    payloads: z.array(deliverPayload),
    ...deliverFields,
  }),
  z.object({ kind: z.literal("session-timeout"), version }),
  z.object({ kind: z.literal("clear"), version }),
  z.object({ kind: z.literal("compact"), version }),
  z.object({ kind: z.literal("reset"), reason: z.string().optional(), version }),
  z.object({
    kind: z.literal("cancel"),
    taskId: z.string().optional(),
    turnId: z.string().optional(),
    version,
  }),
]);

export type SessionInboxWire = z.output<typeof sessionInboxWireSchema>;

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
    migrate: (prior) => {
      const value = prior as { readonly kind?: unknown };
      if (value.kind !== "send") return { ...(value as object), version: 1 };

      const send = value as SendCommand;
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
    },
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

  const parsed = sessionInboxWireSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} failed the v${SESSION_INBOX_WIRE_VERSION} schema: ${formatValidationError(parsed.error)}`,
    );
  }

  return normalizeWire(parsed.data);
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
        payloads: wire.payloads,
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
  }
}

/**
 * Encodes a session command as the current wire version, validated against
 * the current schema before it persists so producer drift dies at the
 * producer instead of at a pinned consumer weeks later.
 */
export function encodeSessionCommand(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWire {
  const wire: SessionInboxWire =
    command.kind === "send"
      ? {
          auth: command.auth,
          caller: command.caller,
          deliveryMetadata:
            command.delivery === undefined
              ? undefined
              : [{ ...command.delivery, payloadIndex: 0 }],
          kind: "deliver" as const,
          payload: command.payload,
          payloads: [command.payload],
          requestId: command.requestId,
          taskDeliveryId: command.taskDeliveryId,
          turnPolicy: command.turnPolicy,
          version: SESSION_INBOX_WIRE_VERSION,
        }
      : command.kind === "deliver"
        ? {
            ...command,
            payload: coalesceDeliverPayloads(command.payloads),
            version: SESSION_INBOX_WIRE_VERSION,
          }
      : { ...command, version: SESSION_INBOX_WIRE_VERSION };

  const parsed = sessionInboxWireSchema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `produced a ${WIRE_LABEL} the current v${SESSION_INBOX_WIRE_VERSION} schema rejects: ${formatValidationError(parsed.error)}`,
    );
  }
  // Return the parsed value, not the built object: the schema strips keys it
  // does not declare, so a caller-supplied stowaway field cannot ride onto
  // the durable wire. Opaque interiors cross by reference, so this keeps the
  // envelope's internal aliasing (`payloads[0] === payload`) intact.
  return parsed.data;
}
