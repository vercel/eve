import type { ModelMessage } from "ai";

import type { HarnessSession } from "#harness/types.js";

const TURN_DELIVERY_CONTEXT_KEY = "eve.harness.turnDeliveryContext";
const TURN_CLIENT_CONTEXT_KEY = "eve.harness.turnClientContext";

/** Returns caller-authored context attached to the active turn. */
export function getTurnClientContext(session: HarnessSession): readonly string[] {
  return (session.state?.[TURN_CLIENT_CONTEXT_KEY] as readonly string[] | undefined) ?? [];
}

/** Builds an ephemeral resolver/model view with caller context overlaid as user messages. */
export function buildTurnClientContextView(
  session: HarnessSession,
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return [
    ...messages,
    ...getTurnClientContext(session).map((content) => ({ role: "user" as const, content })),
  ];
}

/** Builds the full active-turn prompt view used only for token accounting. */
export function buildTurnContextAccountingView(
  session: HarnessSession,
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return [
    ...buildTurnClientContextView(session, messages),
    ...getTurnDeliveryContext(session).map((content) => ({ role: "system" as const, content })),
  ];
}

/** Replaces the active turn's caller context without adding it to model history. */
export function setTurnClientContext(
  session: HarnessSession,
  context: readonly string[] | undefined,
): HarnessSession {
  return setStoredContext(session, TURN_CLIENT_CONTEXT_KEY, context);
}

/** Returns the channel context attached to the active turn. */
export function getTurnDeliveryContext(session: HarnessSession): readonly string[] {
  return (session.state?.[TURN_DELIVERY_CONTEXT_KEY] as readonly string[] | undefined) ?? [];
}

/** Replaces the active turn's channel context without adding it to model history. */
export function setTurnDeliveryContext(
  session: HarnessSession,
  context: readonly string[] | undefined,
): HarnessSession {
  return setStoredContext(session, TURN_DELIVERY_CONTEXT_KEY, context);
}

/** Clears context that must not survive the active turn. */
export function clearTurnContext(session: HarnessSession): HarnessSession {
  return setTurnDeliveryContext(setTurnClientContext(session, undefined), undefined);
}

function setStoredContext(
  session: HarnessSession,
  key: string,
  context: readonly string[] | undefined,
): HarnessSession {
  const current = (session.state?.[key] as readonly string[] | undefined) ?? [];
  const next = context ?? [];

  if (current.length === 0 && next.length === 0) {
    return session;
  }

  const state = { ...session.state };
  if (next.length > 0) {
    state[key] = next;
  } else {
    delete state[key];
  }

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}
