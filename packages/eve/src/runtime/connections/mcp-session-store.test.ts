import { describe, expect, it } from "vitest";

import {
  collectMcpSessionUpdates,
  mcpSessionStateKey,
  readMcpSessionState,
  type DurableMcpSessionState,
  type McpSessionSlot,
} from "#runtime/connections/mcp-session-store.js";

const initializeResult = {
  capabilities: {},
  protocolVersion: "2025-11-25",
  serverInfo: { name: "test-server", version: "1.0.0" },
} as const;

function state(sessionId: string): DurableMcpSessionState {
  return { initializeResult, sessionId };
}

describe("mcpSessionStateKey", () => {
  it("includes connection name and principal", () => {
    expect(mcpSessionStateKey("linear", "issuer:user-1")).toBe(
      "eve.mcp.session.linear.issuer:user-1",
    );
  });

  it('falls back to "anonymous" for no principal', () => {
    expect(mcpSessionStateKey("linear", null)).toBe("eve.mcp.session.linear.anonymous");
    expect(mcpSessionStateKey("linear", undefined)).toBe("eve.mcp.session.linear.anonymous");
  });
});

describe("readMcpSessionState", () => {
  it("accepts stored session metadata", () => {
    expect(readMcpSessionState(state("session-1"))).toEqual(state("session-1"));
  });

  it("ignores legacy or malformed stored values", () => {
    expect(readMcpSessionState("session-1")).toBeUndefined();
    expect(readMcpSessionState({ sessionId: "session-1" })).toBeUndefined();
    expect(
      readMcpSessionState({
        initializeResult: { capabilities: {}, protocolVersion: "2025-11-25" },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });
});

describe("collectMcpSessionUpdates", () => {
  it("returns changed, created, and cleared session states", () => {
    const unchanged = state("unchanged");
    const slots = new Map<string, McpSessionSlot>([
      ["created", { current: state("created"), stateKey: "k.created" }],
      ["unchanged", { current: unchanged, initial: unchanged, stateKey: "k.unchanged" }],
      ["rotated", { current: state("new"), initial: state("old"), stateKey: "k.rotated" }],
      ["cleared", { initial: state("expired"), stateKey: "k.cleared" }],
      ["empty", { stateKey: "k.empty" }],
    ]);

    expect(collectMcpSessionUpdates(slots)).toEqual([
      { state: state("created"), stateKey: "k.created" },
      { state: state("new"), stateKey: "k.rotated" },
      { state: undefined, stateKey: "k.cleared" },
    ]);
  });
});
