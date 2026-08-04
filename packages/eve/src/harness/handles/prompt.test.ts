import { describe, expect, it } from "vitest";

import {
  projectParkedAgentHandles,
  renderAgentsSnippet,
  resolveAgentsAnnouncement,
} from "#harness/handles/prompt.js";
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
    expect(snippet).not.toContain("URL_SENTINEL");
    expect(snippet).not.toContain("CALLBACK_SENTINEL");
  });
});

describe("resolveAgentsAnnouncement", () => {
  it("announces a changed listing without replacing earlier conversation content", () => {
    const messages = [{ content: "Earlier response", role: "assistant" as const }];
    const content = resolveAgentsAnnouncement({
      messages,
      store: { handles: [parkedRemoteHandle] },
    });

    expect(content).toContain(`<agent id="${identity.id}"`);
    expect(messages).toEqual([{ content: "Earlier response", role: "assistant" }]);
  });

  it("does not repeat an unchanged listing", () => {
    const content = renderAgentsSnippet({ handles: [parkedRemoteHandle] });

    expect(
      resolveAgentsAnnouncement({
        messages: [{ content, role: "assistant" }],
        store: { handles: [parkedRemoteHandle] },
      }),
    ).toBeUndefined();
  });

  it("announces an empty listing after the last parked handle disappears", () => {
    const previous = renderAgentsSnippet({ handles: [parkedRemoteHandle] });

    expect(
      resolveAgentsAnnouncement({
        messages: [{ content: previous, role: "assistant" }],
        store: { handles: [runningHandle] },
      }),
    ).toBe("[Agents]\n<agents>\n</agents>");
  });

  it("skips empty scaffolding when no listing was previously announced", () => {
    expect(resolveAgentsAnnouncement({ messages: [], store: undefined })).toBeUndefined();
  });
});
