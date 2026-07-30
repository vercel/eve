import { describe, expect, it } from "vitest";

import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  getAgentHandleStore,
  removeAgentHandle,
  renderAgentsSnippet,
  upsertAgentHandle,
  type LocalAgentHandle,
  type RemoteAgentHandle,
} from "#harness/agent-handles.js";
import type { HarnessSession } from "#harness/types.js";

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_test" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_test",
    history: [],
    sessionId: "session_test",
    state,
  };
}

function createHandle(overrides: Partial<LocalAgentHandle> = {}): LocalAgentHandle {
  return {
    continuationToken: "continuation_handle",
    id: "ag_research:abcdefghijkl",
    kind: "agent/local",
    name: "research",
    nodeId: "node_research",
    relationship: "child",
    sessionId: "session_abcdefghijkl",
    updatedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("deriveAgentId", () => {
  it("uses the agent name and final twelve session-id characters", () => {
    expect(deriveAgentId("research", "session_123456789012")).toBe("ag_research:123456789012");
  });
});

describe("getAgentHandleStore", () => {
  it("returns undefined only when no store has been written", () => {
    expect(getAgentHandleStore(undefined)).toBeUndefined();
    expect(getAgentHandleStore({})).toBeUndefined();
  });

  it("throws on a present but malformed store instead of treating it as absent", () => {
    for (const malformed of [
      null,
      { handles: "not-an-array" },
      { handles: [{ id: "incomplete" }] },
      { handles: [{ ...createHandle(), kind: "agent/remote" }] },
    ]) {
      expect(() => getAgentHandleStore({ [AGENT_HANDLES_STATE_KEY]: malformed })).toThrow(
        AGENT_HANDLES_STATE_KEY,
      );
    }
  });
});

describe("upsertAgentHandle", () => {
  it("replaces an existing handle by id without mutating the prior session", () => {
    const originalHandle = createHandle({ lastStatus: "working" });
    const inserted = upsertAgentHandle(createSession(), originalHandle);
    const replacement = createHandle({ description: "next task", lastStatus: "done" });

    const replaced = upsertAgentHandle(inserted, replacement);

    expect(getAgentHandleStore(replaced.state)?.handles).toEqual([replacement]);
    expect(getAgentHandleStore(inserted.state)?.handles).toEqual([originalHandle]);
  });
});

describe("removeAgentHandle", () => {
  it("returns the same session reference when the id is absent", () => {
    const session = upsertAgentHandle(createSession(), createHandle());

    expect(removeAgentHandle(session, "ag_missing:000000000000")).toBe(session);
  });
});

describe("renderAgentsSnippet", () => {
  it("starts with the synthetic label and omits private delivery coordinates", () => {
    const url = "https://URL_SENTINEL.invalid";
    const callbackBaseUrl = "https://CALLBACK_SENTINEL.invalid";
    const continuationToken = "CONTINUATION_TOKEN_SENTINEL";
    const sessionId = "SESSION_ID_SENTINEL_123456789";
    const remoteHandle: RemoteAgentHandle = {
      callbackBaseUrl,
      continuationToken,
      id: "ag_research:visible-id",
      kind: "agent/remote",
      lastStatus: "waiting for input",
      name: "research",
      nodeId: "node_research",
      relationship: "child",
      sessionId,
      updatedAt: "2026-07-28T12:00:00.000Z",
      url,
    };
    const snippet = renderAgentsSnippet({ handles: [remoteHandle] });

    expect(snippet.startsWith("[Agents]\n<agents>")).toBe(true);
    expect(snippet).toContain(
      '<agent id="ag_research:visible-id" name="research">waiting for input</agent>',
    );
    expect(snippet).not.toContain(url);
    expect(snippet).not.toContain(callbackBaseUrl);
    expect(snippet).not.toContain(continuationToken);
    expect(snippet).not.toContain(sessionId);
  });
});
