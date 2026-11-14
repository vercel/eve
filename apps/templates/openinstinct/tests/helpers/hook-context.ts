import { emptySessionView } from "eve/events";
import type { HookContext } from "eve/hooks";

type HookSession = HookContext["session"];

interface TestHookContextOptions {
  readonly agentName?: string;
  readonly auth?: HookSession["auth"];
  readonly channel?: HookContext["channel"];
  readonly continueTurn?: HookContext<"turn.settled">["continue"];
  readonly now?: Date;
  readonly parent?: HookSession["parent"];
  readonly position?: HookContext["position"];
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly view?: HookContext["view"];
}

/** A hook context for focused hook tests; pass a folded `view` for state. */
export function hookContextFor({
  agentName = "test-agent",
  auth = { current: null, initiator: null },
  channel = { kind: "channel:eve", metadata: {} },
  continueTurn = () => ({ queued: false, reason: "not-settled" }),
  now = new Date("2026-01-01T00:00:00.000Z"),
  parent,
  position = { index: 0, line: 0 },
  sessionId = "test-session",
  turnId = "turn-1",
  view = emptySessionView(),
}: TestHookContextOptions = {}): HookContext<"turn.settled"> {
  return {
    agent: { name: agentName },
    cancel: () => undefined,
    channel,
    continue: continueTurn,
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    memo: async (_key, fn) =>
      fn({ abortSignal: new AbortController().signal, idempotencyKey: "memo" }),
    now,
    occurrence: {
      abortSignal: new AbortController().signal,
      idempotencyKey: `${sessionId}:${String(position.line)}:${String(position.index)}`,
    },
    position,
    session: {
      auth,
      id: sessionId,
      parent,
      turn: { id: turnId, sequence: 0 },
    },
    turn: { id: turnId, input: [], status: "running" },
    view,
  };
}
