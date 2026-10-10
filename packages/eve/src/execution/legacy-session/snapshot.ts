import type { ModelMessage } from "ai";
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

export type LegacySession = DurableSession & { readonly history: ModelMessage[] };

const LEGACY_EMISSION_KEY = "eve.harness.emission";

const PRESERVED_FRAMEWORK_STATE = new Set([
  "eve.harness.turnUsage",
  "eve.harness.reportedSessionUsage",
  "eve.harness.sessionRuntimeTokenLimit",
]);

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

/** The turn position a legacy driver persisted, as the projection that replaces it. */
export function importProjection(session: LegacySession): SessionProjection {
  const raw = session.state?.[LEGACY_EMISSION_KEY];
  const projection = initialSessionProjection();
  if (!isObject(raw) || typeof raw.sequence !== "number") return projection;
  const started = raw.sessionStarted === true ? { started: true as const } : {};
  const turnId = typeof raw.turnId === "string" ? raw.turnId : "";
  if (turnId === "") return { ...projection, ...started, nextSequence: raw.sequence };
  // A legacy driver kept the index its next step takes; the projection keeps the last started.
  const next = typeof raw.stepIndex === "number" ? raw.stepIndex : 0;
  return {
    ...projection,
    ...started,
    activeTurnId: turnId,
    nextSequence: raw.sequence + 1,
    turns: {
      [turnId]: {
        turnId,
        sequence: raw.sequence,
        status: "active",
        ...(next > 0 && { stepIndex: next - 1 }),
      },
    },
  };
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
