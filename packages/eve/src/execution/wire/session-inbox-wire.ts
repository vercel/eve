import type {
  DeliverHookPayload,
  DeliverPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  runMigrationChain,
  type VersionMigration,
} from "#execution/durable-session-migrations/chain.js";

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

function isOpaqueObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Field kinds the envelope declares; interiors stay opaque. */
type FieldType = "object" | "object-or-null" | "object[]" | "string" | "turn-policy";

const FIELD_CHECKS: Readonly<Record<FieldType, (value: unknown) => boolean>> = {
  object: isOpaqueObject,
  "object-or-null": (value) => value === null || isOpaqueObject(value),
  "object[]": (value) => Array.isArray(value) && value.every(isOpaqueObject),
  string: (value) => typeof value === "string",
  "turn-policy": (value) => value === "queue" || value === "steer",
};

/**
 * v1, the current wire shape: payload kind → its envelope fields, where a
 * `?` suffix marks the field optional. `kind` and `version` are implicit.
 *
 * This table is both the validator and the frozen contract, so the artifact
 * CI pins and the code that enforces it cannot drift apart.
 *
 * The deliver `payload` mirror is transitional: consumers pinned to eve
 * 0.30.3–0.30.8 cast any non-control payload to a `send` command and read
 * `.payload`, so the mirror is what keeps their parked sessions receiving
 * messages. Sessions are bounded by the 30-day default timeout; the version
 * after this drops the mirror once runs created on those versions have aged
 * out.
 */
export const SESSION_INBOX_V1_FIELDS = {
  cancel: { taskId: "string?", turnId: "string?" },
  clear: {},
  compact: {},
  deliver: {
    auth: "object-or-null?",
    caller: "object?",
    deliveryMetadata: "object[]?",
    payload: "object?",
    payloads: "object[]",
    requestId: "string?",
    taskDeliveryId: "string?",
    turnPolicy: "turn-policy?",
  },
  reset: { reason: "string?" },
  "session-timeout": {},
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, `${FieldType}` | `${FieldType}?`>>>
>;

export type SessionInboxWire =
  | (DeliverHookPayload & { readonly payload?: DeliverPayload; readonly version: 1 })
  | { readonly kind: "cancel"; readonly taskId?: string; readonly turnId?: string; readonly version: 1 }
  | { readonly kind: "clear"; readonly version: 1 }
  | { readonly kind: "compact"; readonly version: 1 }
  | { readonly kind: "reset"; readonly reason?: string; readonly version: 1 }
  | { readonly kind: "session-timeout"; readonly version: 1 };

/**
 * Validates one current-version envelope and returns it with undeclared
 * keys removed, so a caller-supplied field cannot ride onto durable storage.
 */
function parseWire(value: object): SessionInboxWire {
  const envelope = value as Record<string, unknown>;
  const kind = envelope.kind;
  const fields = (SESSION_INBOX_V1_FIELDS as Record<string, Record<string, string>>)[
    typeof kind === "string" ? kind : ""
  ];
  if (fields === undefined) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} has an unrecognized kind ${JSON.stringify(kind)}; expected ${Object.keys(SESSION_INBOX_V1_FIELDS).join(" | ")}.`,
    );
  }
  if (envelope.version !== SESSION_INBOX_WIRE_VERSION) {
    throw new SessionInboxWireError(
      `${WIRE_LABEL} declares version ${JSON.stringify(envelope.version)}, expected ${SESSION_INBOX_WIRE_VERSION}.`,
    );
  }

  const parsed: Record<string, unknown> = { kind, version: SESSION_INBOX_WIRE_VERSION };
  for (const [field, spec] of Object.entries(fields)) {
    const optional = spec.endsWith("?");
    const type = (optional ? spec.slice(0, -1) : spec) as FieldType;
    const candidate = envelope[field];
    if (candidate === undefined) {
      if (!optional) {
        throw new SessionInboxWireError(`${WIRE_LABEL} is missing required field "${field}".`);
      }
      continue;
    }
    if (!FIELD_CHECKS[type](candidate)) {
      throw new SessionInboxWireError(`${WIRE_LABEL} field "${field}" is not ${type}.`);
    }
    parsed[field] = candidate;
  }
  return parsed as SessionInboxWire;
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

  return normalizeWire(parseWire(migrated as object));
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
 * the current field table before it persists so producer drift dies at the
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

  // Return the parsed envelope, not the built object: parseWire copies only
  // declared fields, so a caller-supplied stowaway cannot ride onto the
  // durable wire. Opaque interiors are copied by reference, so the envelope's
  // internal aliasing (`payloads[0] === payload`) stays intact.
  return parseWire(wire);
}
