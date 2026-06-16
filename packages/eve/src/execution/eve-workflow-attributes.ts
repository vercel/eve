/**
 * Builders for the framework's reserved `$eve.*` workflow attributes.
 *
 * Each builder returns a plain `Record<string, string | number | undefined>`
 * suitable for `setEveAttributes` from
 * {@link "#runtime/attributes/emit.js" }. Builders are intentionally
 * pure data → data transforms: they hold zero dependencies on the
 * workflow runtime so the workflow body, step bodies, and tests can
 * all call them identically.
 *
 * `$eve.*` is the framework-owned attribute namespace. Authored code
 * never emits these tags directly — they describe the structural shape
 * of a session/turn/subagent run so dashboards can stitch a tree of
 * workflow runs back together without inspecting their bodies.
 *
 * Tag inventory (recap):
 * - `$eve.type`         — `"session" | "turn" | "subagent"`
 * - `$eve.parent`       — sessionId of the **immediate** parent
 * - `$eve.root`         — sessionId of the **root** session in the chain
 * - `$eve.parent_call`  — parent runtime-action tool call id (subagent rows only)
 * - `$eve.parent_turn`  — parent turn id that dispatched the subagent (subagent rows only)
 * - `$eve.subagent`     — active compiled graph node id (subagent rows only)
 * - `$eve.trigger`      — channel adapter kind (session/subagent rows)
 * - `$eve.title`        — truncated session title from the first user message
 */

import type { EveAttributeValue } from "#runtime/attributes/emit.js";
import { isNonEmptyString } from "#shared/guards.js";

/**
 * Active compiled graph node id for the session's agent. Returned by
 * `createSessionStep` so workflow bodies don't have to load the bundle
 * themselves. Equal to the framework root sentinel (`"__root__"`) for
 * the root agent; equal to the subagent's compiled node id for
 * delegated child runs. Tag emitters use this to populate
 * `$eve.subagent`.
 */
export interface SessionIdentitySummary {
  readonly nodeId: string;
}

/** Untyped channel adapter snapshot as it survives serialization. */
interface SerializedChannelAdapter {
  readonly kind?: unknown;
}

/** Untyped session parent snapshot as it survives serialization. */
interface SerializedSessionParent {
  readonly callId?: unknown;
  readonly sessionId?: unknown;
  readonly rootSessionId?: unknown;
  readonly turn?: {
    readonly id?: unknown;
  };
}

/**
 * Parent session lineage decoded from the serialized run context.
 */
export interface SessionParentLineage {
  readonly callId?: string;
  readonly rootSessionId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

/**
 * Reads the active channel kind from a deserialized context map.
 * Returns `undefined` when the channel slot is missing or malformed —
 * tag emission silently drops undefined values.
 */
export function readChannelKind(serializedContext: Record<string, unknown>): string | undefined {
  const channel = serializedContext["eve.channel"] as SerializedChannelAdapter | undefined;
  const kind = channel?.kind;
  return isNonEmptyString(kind) ? kind : undefined;
}

/**
 * Reads parent session lineage from a deserialized context map. Returns
 * an empty object for top-level runs or malformed delegated contexts.
 */
export function readParentLineage(
  serializedContext: Record<string, unknown>,
): SessionParentLineage {
  const parent = serializedContext["eve.parentSession"] as SerializedSessionParent | undefined;
  const callId = parent?.callId;
  const rootSessionId = parent?.rootSessionId;
  const sessionId = parent?.sessionId;
  const turnId = parent?.turn?.id;
  return {
    callId: isNonEmptyString(callId) ? callId : undefined,
    rootSessionId: isNonEmptyString(rootSessionId) ? rootSessionId : undefined,
    sessionId: isNonEmptyString(sessionId) ? sessionId : undefined,
    turnId: isNonEmptyString(turnId) ? turnId : undefined,
  };
}

/**
 * Reads the immediate parent session id from a deserialized context map.
 * Returns `undefined` when the run is a top-level session.
 */
export function readParentSessionId(
  serializedContext: Record<string, unknown>,
): string | undefined {
  return readParentLineage(serializedContext).sessionId;
}

/**
 * Reads the **root** session id from a deserialized context map.
 *
 * `eve.parentSession.rootSessionId` is denormalized at every dispatch
 * site (see {@link "#channel/types.js".SessionParent}) so a subagent
 * five levels deep can still attribute itself to the top user-facing
 * session without walking the chain. Returns `undefined` for top-level
 * runs, which carry no `eve.parentSession`.
 */
export function readRootSessionId(serializedContext: Record<string, unknown>): string | undefined {
  return readParentLineage(serializedContext).rootSessionId;
}

/**
 * Maximum visible length (in code points) of a derived `$eve.title`.
 *
 * Titles render as the first column of the dashboard's run table, so
 * they get a tighter, display-oriented cap here than the generic
 * runtime byte budget (`EVE_ATTRIBUTE_VALUE_MAX_BYTES`). Mostly-ASCII
 * titles stay within that budget; a title dominated by multi-byte
 * characters may still be further truncated by the runtime tag
 * truncator, which is acceptable.
 */
export const EVE_SESSION_TITLE_MAX_CHARS = 125;

/**
 * Derives the `$eve.title` value from the first user message of a
 * top-level session.
 *
 * Returns `undefined` when no plain-text content is available; the
 * attribute emitter strips undefined values. Multimodal messages
 * (image/file parts) contribute only their text parts to keep the
 * title human-readable. Long prompts are truncated to
 * {@link EVE_SESSION_TITLE_MAX_CHARS} code points with a trailing
 * ellipsis so the dashboard's title column stays readable.
 */
export function deriveSessionTitle(message: unknown): string | undefined {
  const text = collectMessageText(message);
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  // Collapse whitespace runs so multi-line user prompts produce a
  // single-line title.
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  // Truncate by code point (not UTF-16 unit) so we never split a
  // surrogate pair, and reserve one slot for the ellipsis.
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= EVE_SESSION_TITLE_MAX_CHARS) {
    return collapsed;
  }
  return `${codePoints.slice(0, EVE_SESSION_TITLE_MAX_CHARS - 1).join("")}…`;
}

function collectMessageText(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (!Array.isArray(message)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of message) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Builds the `$eve.*` attribute payload for a top-level session run
 * (`workflowEntry` invoked without an `eve.parentSession`).
 *
 * `$eve.root` is intentionally omitted — the session row IS the root,
 * so its own `workflowRunId` already identifies the chain root.
 */
export function buildSessionAttributes(input: {
  readonly inputMessage: unknown;
  readonly serializedContext: Record<string, unknown>;
}): Record<string, EveAttributeValue> {
  return {
    "$eve.type": "session",
    "$eve.trigger": readChannelKind(input.serializedContext),
    "$eve.title": deriveSessionTitle(input.inputMessage),
  };
}

/**
 * Builds the `$eve.*` attribute payload for a delegated subagent root
 * run (`workflowEntry` invoked with an `eve.parentSession`).
 *
 * `$eve.root` carries the **root** session id so the dashboard can
 * group every descendant under one query: `search($eve.root=<root>)`
 * returns all turns and nested subagents under that user-facing
 * session in a single round trip.
 */
export function buildSubagentRootAttributes(input: {
  readonly identity: SessionIdentitySummary;
  readonly parentCallId?: string;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly rootSessionId: string;
  readonly serializedContext: Record<string, unknown>;
}): Record<string, EveAttributeValue> {
  return {
    "$eve.type": "subagent",
    "$eve.parent": input.parentSessionId,
    "$eve.parent_call": input.parentCallId,
    "$eve.parent_turn": input.parentTurnId,
    "$eve.root": input.rootSessionId,
    "$eve.subagent": input.identity.nodeId,
    "$eve.trigger": readChannelKind(input.serializedContext),
  };
}

/**
 * Builds the `$eve.*` attribute payload for one turn workflow run.
 *
 * Turns live one level below their session: `$eve.parent` always points
 * to the parent's sessionId (which is the session-row's
 * `workflowRunId`), and `$eve.root` denormalizes the chain root (equal
 * to `$eve.parent` for turns of top-level sessions). Turn ordering is
 * recovered from each run's `createdAt`, so no explicit sequence tag is
 * emitted.
 */
export function buildTurnAttributes(input: {
  readonly parentSessionId: string;
  readonly rootSessionId: string;
}): Record<string, EveAttributeValue> {
  return {
    "$eve.type": "turn",
    "$eve.parent": input.parentSessionId,
    "$eve.root": input.rootSessionId,
  };
}
