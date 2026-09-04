import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const TURN_CLIENT_CONTEXT_STATE_KEY = "eve.harness.turnClientContext";

export interface TurnClientContextState {
  readonly insertionIndex: number;
  readonly messages: readonly string[];
  readonly turnId: string;
}

export function getTurnClientContextState(
  state: SessionStateMap | undefined,
  turnId: string,
): TurnClientContextState | undefined {
  const clientContext = state?.[TURN_CLIENT_CONTEXT_STATE_KEY] as
    | TurnClientContextState
    | undefined;
  return clientContext?.turnId === turnId ? clientContext : undefined;
}

export function setTurnClientContextState(
  session: HarnessSession,
  clientContext: TurnClientContextState,
): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [TURN_CLIENT_CONTEXT_STATE_KEY]: clientContext,
    },
  };
}

export function clearTurnClientContextState(session: HarnessSession): HarnessSession {
  if (session.state?.[TURN_CLIENT_CONTEXT_STATE_KEY] === undefined) return session;

  const { [TURN_CLIENT_CONTEXT_STATE_KEY]: _clientContext, ...state } = session.state;
  return { ...session, state };
}
