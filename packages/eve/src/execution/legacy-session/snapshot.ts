import type { ModelMessage } from "ai";
import { usageOf } from "#harness/facts.js";
import { withModelUsage } from "#harness/session-usage.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import { isUserMessageKind, validateHarnessModelMessages } from "#harness/messages.js";
import {
  DURABLE_SESSION_VERSION,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { isObject } from "#shared/guards.js";
import type { TokenUsage } from "#shared/token-usage.js";

export type LegacySession = DurableSession & { readonly history: ModelMessage[] };

const LEGACY_EMISSION_KEY = "eve.harness.emission";

const PRESERVED_FRAMEWORK_STATE = new Set(["eve.harness.sessionRuntimeTokenLimit"]);
/** What a legacy driver counted the session spent, and how much of it a parent was told. */
const LEGACY_USAGE_KEY = "eve.harness.turnUsage";
const REPORTED_USAGE_KEY = "eve.harness.reportedSessionUsage";

/** Reads the driver's embedded snapshot; every supported driver carries one. */
export function readLegacySnapshot(
  state: Record<string, unknown> & { sessionId: string },
): LegacySession {
  const snapshot = state.snapshot;
  if (
    !isObject(snapshot) ||
    snapshot.version !== 1 ||
    !isObject(snapshot.session) ||
    snapshot.session.sessionId !== state.sessionId ||
    !Array.isArray(snapshot.session.history)
  )
    throw new Error("Unsupported legacy session snapshot.");
  const session: unknown = snapshot.session;
  return session as LegacySession;
}

/** Keep committed conversation data, but no pre-cutover execution registries. */
export function importConversation(session: LegacySession): {
  readonly history: HarnessModelMessage[];
  readonly sessionState: DurableSessionState;
} {
  const { history, ...durable } = session;
  const state = Object.fromEntries(
    Object.entries(session.state ?? {}).filter(
      ([key]) => !key.startsWith("eve.") || PRESERVED_FRAMEWORK_STATE.has(key),
    ),
  );
  const reported = legacyUsage(session.state?.[REPORTED_USAGE_KEY]);
  if (reported !== undefined) state[REPORTED_USAGE_KEY] = reported;
  return {
    history: normalizeHistory(history),
    sessionState: {
      version: DURABLE_SESSION_VERSION,
      sessionId: session.sessionId,
      continuationToken: session.continuationToken,
      hasProxyInputRequests: false,
      snapshot: {
        session: {
          ...durable,
          state: { ...state, [SESSION_PROJECTION_STATE_KEY]: importProjection(session) },
        },
      },
    },
  };
}

/**
 * The turn position a legacy driver persisted, as the projection that replaces it, with what it
 * counted the session spent as the view's usage, so the session's limits keep counting.
 */
export function importProjection(session: LegacySession): SessionProjection {
  const raw = session.state?.[LEGACY_EMISSION_KEY];
  const initial = initialSessionProjection();
  const spent = legacyUsage(
    isObject(session.state?.[LEGACY_USAGE_KEY])
      ? session.state[LEGACY_USAGE_KEY].session
      : undefined,
  );
  const projection =
    spent === undefined ? initial : { ...initial, view: withModelUsage(initial.view, spent) };
  if (!isObject(raw) || typeof raw.sequence !== "number") return projection;
  const { view } = projection;
  const status = raw.sessionStarted === true ? ("open" as const) : ("new" as const);
  const turnId = typeof raw.turnId === "string" ? raw.turnId : "";
  if (turnId === "") {
    return { ...projection, view: { ...view, session: { status, turnCount: raw.sequence } } };
  }
  // A legacy driver kept the index its next step takes: the steps its turn already ran.
  const runs = typeof raw.stepIndex === "number" ? raw.stepIndex : 0;
  const turn = {
    cause: { hook: "legacy" },
    follows: null,
    introducedAt: 0,
    startedAt: new Date(0).toISOString(),
    status: "running" as const,
    turnId,
    ...(runs > 0 && { runs }),
  };
  return {
    ...projection,
    view: {
      ...view,
      session: { latestTurnId: turnId, status, turnCount: raw.sequence + 1 },
      turns: { [turnId]: turn },
    },
  };
}

/** A legacy usage total: its counts, and its cost only when a provider reported one. */
function legacyUsage(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const count = (field: string) => (typeof raw[field] === "number" ? raw[field] : 0);
  return usageOf({
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: raw.sawCost === true && typeof raw.costUsd === "number" ? raw.costUsd : undefined,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
  });
}

export function normalizeHistory(messages: readonly ModelMessage[]) {
  const history: ModelMessage[] = [];
  const pending = new Map<string, string>();
  const settle = () => {
    if (pending.size === 0) return;
    history.push({
      role: "tool",
      content: [...pending].map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: {
          type: "error-text" as const,
          value: "Interrupted by the session upgrade. Start this work again if it is still needed.",
        },
      })),
    });
    pending.clear();
  };
  for (const original of messages) {
    let message = original;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      message = {
        ...message,
        content: message.content.filter((part) => part.type !== "tool-approval-request"),
      };
    } else if (message.role === "tool") {
      message = {
        ...message,
        content: message.content.filter((part) => part.type !== "tool-approval-response"),
      };
      if (message.content.length === 0) continue;
    }
    if (message.role !== "tool") settle();
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content)
        if (part.type === "tool-call") pending.set(part.toolCallId, part.toolName);
    }
    if (message.role === "tool") {
      for (const part of message.content)
        if (part.type === "tool-result") pending.delete(part.toolCallId);
    }
    const kind = (message as { kind?: unknown }).kind;
    history.push(
      message.role === "user" && !isUserMessageKind(kind)
        ? ({ ...message, kind: "user" } as ModelMessage)
        : message,
    );
  }
  settle();
  return validateHarnessModelMessages(history);
}
