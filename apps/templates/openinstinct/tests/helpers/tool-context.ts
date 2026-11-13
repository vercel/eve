import type { ToolContext } from "eve/tools";

interface TestToolContextOptions {
  readonly abortSignal?: AbortSignal;
  readonly auth?: ToolContext["session"]["auth"];
  readonly callId?: string;
  readonly channel?: ToolContext["channel"];
  readonly parentSessionId?: string;
  readonly sessionId?: string;
  readonly toolName?: string;
}

export function toolContextFor({
  abortSignal = new AbortController().signal,
  auth = { current: null, initiator: null },
  callId = "test-call",
  channel = { kind: "channel:eve", metadata: {} },
  parentSessionId,
  sessionId = "test-session",
  toolName = "test-tool",
}: TestToolContextOptions = {}): ToolContext {
  const parent = parentSessionId
    ? {
        callId: "parent-call",
        rootSessionId: parentSessionId,
        sessionId: parentSessionId,
        turn: { id: "parent-turn", sequence: 0 },
      }
    : undefined;
  return {
    abortSignal,
    callId,
    channel,
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    async getToken() {
      throw new Error("Authorization is outside this focused test.");
    },
    messages: [],
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth,
      id: sessionId,
      parent,
      turn: { id: "test-turn", sequence: 0 },
    },
    to() {
      throw new Error("Cross-channel delivery is outside this focused test.");
    },
    toolName,
  };
}
