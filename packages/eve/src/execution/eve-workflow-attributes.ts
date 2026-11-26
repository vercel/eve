import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import {
  ChannelRequestIdKey,
  OtelTraceEnabledKey,
  ScheduleIdKey,
  SessionTitleKey,
  SessionTraceSeedKey,
  type SessionTraceSeed,
} from "#context/keys.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import { isNonEmptyString } from "#shared/guards.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  ConversationContextKey,
  normalizeConversationContext,
} from "#shared/conversation-context.js";
import { EVE_MESSAGE_STREAM_VERSION } from "#protocol/session-http.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { resolveForwardedTraceSeed } from "#shared/forwarded-trace-policy.js";

export const EVE_PREWARM_ATTRIBUTE = "$eve.prewarm";

export const EVE_VERSION_ATTRIBUTE = "$eve.version";

export const EVE_STREAM_VERSION_ATTRIBUTE = "$eve.stream_version";

export const EVE_TYPE_ATTRIBUTE = "$eve.type";

const FIRST_V27_MINOR = 84;
const SEMVER_PREFIX = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function resolveSessionStreamVersion(
  attributes: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  const explicit = attributes?.[EVE_STREAM_VERSION_ATTRIBUTE];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const eveVersion = attributes?.[EVE_VERSION_ATTRIBUTE];
  if (eveVersion === undefined) return undefined;
  const match = SEMVER_PREFIX.exec(eveVersion.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= FIRST_V27_MINOR ? EVE_MESSAGE_STREAM_VERSION : undefined;
}

export const EVE_SESSION_ATTRIBUTE = "$eve.session";

export const EVE_ROOT_ATTRIBUTE = "$eve.root";

interface SessionIdentitySummary {
  readonly nodeId: string;
}

interface SerializedChannelAdapter {
  readonly kind?: unknown;
}

interface SerializedSessionParent {
  readonly callId?: unknown;
  readonly sessionId?: unknown;
  readonly rootSessionId?: unknown;
  readonly turn?: {
    readonly id?: unknown;
  };
}

interface SessionParentLineage {
  readonly callId?: string;
  readonly rootSessionId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export function readChannelKind(serializedContext: Record<string, unknown>): string | undefined {
  const channel = serializedContext[CHANNEL_CONTEXT_KEY_NAME] as
    | SerializedChannelAdapter
    | undefined;
  const kind = channel?.kind;
  return isNonEmptyString(kind) ? kind : undefined;
}

export function isWorkflowTraceContentVisible(serializedContext: Record<string, unknown>): boolean {
  const seed = serializedContext[SessionTraceSeedKey.name] as SessionTraceSeed | undefined;
  const traceState = seed === undefined ? undefined : resolveForwardedTraceSeed(seed)!;
  if (traceState !== undefined) {
    if (
      traceState.forwardedTracePolicy !== undefined ||
      readParentSessionId(serializedContext) !== undefined
    ) {
      return recordsAllContent(traceState.decision);
    }
  }
  const conversation = normalizeConversationContext(serializedContext[ConversationContextKey.name]);
  const content = {
    audience: conversation?.audience ?? "unknown",
    environment: conversation?.environment ?? "production",
  };
  const visibleByDefault = shouldCaptureInstrumentationContent(content);
  if (
    !visibleByDefault ||
    traceState?.decision === undefined ||
    !isWorkflowOtelTraceEnabled(serializedContext)
  ) {
    return visibleByDefault;
  }
  return recordsAllContent(traceState.decision);
}

function recordsAllContent(decision: InstrumentationDecision | undefined): boolean {
  return decision?.action === "record" && decision.recordInputs && decision.recordOutputs;
}

function isWorkflowOtelTraceEnabled(serializedContext: Record<string, unknown>): boolean {
  return serializedContext[OtelTraceEnabledKey.name] === true;
}

export function readSessionTraceId(serializedContext: Record<string, unknown>): string | undefined {
  const seed = serializedContext[SessionTraceSeedKey.name] as SessionTraceSeed | undefined;
  if (seed === undefined) return undefined;
  const traceState = resolveForwardedTraceSeed(seed)!;
  if (!isSampledTrace(traceState)) return undefined;
  return isNonEmptyString(seed.traceId) ? seed.traceId : undefined;
}

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

export function readParentSessionId(
  serializedContext: Record<string, unknown>,
): string | undefined {
  return readParentLineage(serializedContext).sessionId;
}

export function readRootSessionId(serializedContext: Record<string, unknown>): string | undefined {
  return readParentLineage(serializedContext).rootSessionId;
}

export function readChannelRequestId(
  serializedContext: Record<string, unknown>,
): string | undefined {
  const channelRequestId = serializedContext[ChannelRequestIdKey.name];
  return isNonEmptyString(channelRequestId) ? channelRequestId : undefined;
}

export function readScheduleId(serializedContext: Record<string, unknown>): string | undefined {
  const scheduleId = serializedContext[ScheduleIdKey.name];
  return isNonEmptyString(scheduleId) ? scheduleId : undefined;
}

function readSessionTitle(serializedContext: Record<string, unknown>): string | undefined {
  const title = serializedContext[SessionTitleKey.name];
  return isNonEmptyString(title) ? title : undefined;
}

export const EVE_SESSION_TITLE_MAX_CHARS = 125;

export function deriveSessionTitle(message: unknown): string | undefined {
  const text = collectMessageText(message);
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
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

export function buildSessionAttributes(input: {
  readonly serializedContext: Record<string, unknown>;
}): Record<string, EveAttributeValue> {
  const isTraceContentVisible = isWorkflowTraceContentVisible(input.serializedContext);
  const isOtelTraceEnabled = isWorkflowOtelTraceEnabled(input.serializedContext);
  return {
    "$eve.channel_request_id": readChannelRequestId(input.serializedContext),
    "$eve.schedule": readScheduleId(input.serializedContext),
    "$eve.is_otel_trace_enabled": isOtelTraceEnabled,
    "$eve.is_trace_content_visible": isTraceContentVisible,
    "$eve.trace_id": readSessionTraceId(input.serializedContext),
    [EVE_TYPE_ATTRIBUTE]: "session",
    "$eve.trigger": readChannelKind(input.serializedContext),
    "$eve.title": readSessionTitle(input.serializedContext),
  };
}

export function buildSubagentRootAttributes(input: {
  readonly identity: SessionIdentitySummary;
  readonly parentCallId?: string;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly rootSessionId: string;
  readonly serializedContext: Record<string, unknown>;
}): Record<string, EveAttributeValue> {
  return {
    "$eve.channel_request_id": readChannelRequestId(input.serializedContext),
    "$eve.is_otel_trace_enabled": isWorkflowOtelTraceEnabled(input.serializedContext),
    "$eve.is_trace_content_visible": isWorkflowTraceContentVisible(input.serializedContext),
    "$eve.trace_id": readSessionTraceId(input.serializedContext),
    [EVE_TYPE_ATTRIBUTE]: "subagent",
    "$eve.parent": input.parentSessionId,
    "$eve.parent_call": input.parentCallId,
    "$eve.parent_turn": input.parentTurnId,
    [EVE_ROOT_ATTRIBUTE]: input.rootSessionId,
    "$eve.subagent": input.identity.nodeId,
    "$eve.trigger": readChannelKind(input.serializedContext),
  };
}
