import { describe, expect, it } from "vitest";

import { projectParkedAgentHandles, renderAgentsSnippet } from "#harness/handles/prompt.js";
import type { AgentHandle } from "#harness/handles/store.js";

const identity = {
  id: "ag_research:abcdef123456",
  name: "research",
  nodeId: "node_research",
} as const;

const runningHandle: AgentHandle = {
  address: {
    continuationToken: "CONTINUATION_TOKEN_SENTINEL",
    kind: "agent/local",
    sessionId: "SESSION_ID_SENTINEL_123456789",
  },
  identity,
  operation: {
    callId: "call_1",
    id: "op_1",
    kind: "start",
    parentTurnId: "turn_1",
  },
  phase: "running",
};

const parkedRemoteHandle: AgentHandle = {
  address: {
    callbackBaseUrl: "https://CALLBACK_SENTINEL.invalid",
    continuationToken: "CONTINUATION_TOKEN_SENTINEL",
    kind: "agent/remote",
    sessionId: "SESSION_ID_SENTINEL_123456789",
    url: "https://URL_SENTINEL.invalid",
  },
  identity,
  lastStatus: "initial findings",
  phase: "parked",
};

describe("projectParkedAgentHandles / renderAgentsSnippet", () => {
  it("projects and renders only parked handles", () => {
    const runningStore = { handles: [runningHandle] };
    expect(projectParkedAgentHandles(runningStore)).toEqual([]);
    expect(renderAgentsSnippet(runningStore)).toBe("[Agents]\n<agents>\n</agents>");

    const parkedStore = { handles: [parkedRemoteHandle] };
    expect(projectParkedAgentHandles(parkedStore)).toEqual([parkedRemoteHandle]);
    const snippet = renderAgentsSnippet(parkedStore);
    expect(snippet.startsWith("[Agents]\n<agents>")).toBe(true);
    expect(snippet).toContain(
      `<agent id="${identity.id}" name="research">initial findings</agent>`,
    );
  });

  it("omits private delivery coordinates and renders a placeholder for empty statuses", () => {
    const snippet = renderAgentsSnippet({
      handles: [{ ...parkedRemoteHandle, lastStatus: "" }],
    });

    expect(snippet).toContain("(no status)");
    expect(snippet).not.toContain(parkedRemoteHandle.address.sessionId);
    expect(snippet).not.toContain(parkedRemoteHandle.address.continuationToken);
    expect(snippet).not.toContain("URL_SENTINEL");
    expect(snippet).not.toContain("CALLBACK_SENTINEL");
  });
});
