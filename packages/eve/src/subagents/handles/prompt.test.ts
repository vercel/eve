import { describe, expect, it } from "vitest";

import {
  isAgentAnnouncementText,
  projectParkedAgentHandles,
  renderAgentAnnouncement,
  resolveAgentAnnouncements,
} from "#subagents/handles/prompt.js";
import type { AgentHandle } from "#subagents/handles/store.js";

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

describe("renderAgentAnnouncement", () => {
  it("renders one self-contained lifecycle element", () => {
    expect(
      renderAgentAnnouncement({ id: identity.id, name: identity.name, status: "created" }),
    ).toBe('<agent status="created" name="research" id="ag_research:abcdef123456"/>');
    expect(
      renderAgentAnnouncement({
        id: identity.id,
        name: identity.name,
        status: "available",
        statusLine: "initial findings",
      }),
    ).toBe(
      '<agent status="available" name="research" id="ag_research:abcdef123456">initial findings</agent>',
    );
  });

  it("escapes public fields and omits empty status text", () => {
    const announcement = renderAgentAnnouncement({
      id: 'ag_&"<>',
      name: 'research&"<>',
      status: "working",
      statusLine: "",
      taskId: 'task_&"<>',
    });

    expect(announcement).toBe(
      '<agent status="working" name="research&amp;&quot;&lt;&gt;" id="ag_&amp;&quot;&lt;&gt;" taskId="task_&amp;&quot;&lt;&gt;"/>',
    );
    expect(isAgentAnnouncementText(announcement)).toBe(true);
    expect(isAgentAnnouncementText("<agent>authored text</agent>")).toBe(false);
  });
});

describe("resolveAgentAnnouncements", () => {
  it("introduces a newly visible agent before announcing its current state", () => {
    expect(
      resolveAgentAnnouncements({ messages: [], store: { handles: [parkedRemoteHandle] } }),
    ).toEqual([
      '<agent status="created" name="research" id="ag_research:abcdef123456"/>',
      '<agent status="available" name="research" id="ag_research:abcdef123456">initial findings</agent>',
    ]);
  });

  it("does not repeat unchanged state", () => {
    const available = renderAgentAnnouncement({
      id: identity.id,
      name: identity.name,
      status: "available",
      statusLine: "initial findings",
    });

    expect(
      resolveAgentAnnouncements({
        messages: [{ content: available, role: "user" }],
        store: { handles: [parkedRemoteHandle] },
      }),
    ).toEqual([]);
  });

  it("announces only the agent whose state changed", () => {
    const other: AgentHandle = {
      ...parkedRemoteHandle,
      identity: { id: "ag_other:123456789012", name: "other", nodeId: "node-other" },
      lastStatus: "unchanged",
    };
    const researchBefore = renderAgentAnnouncement({
      id: identity.id,
      name: identity.name,
      status: "available",
      statusLine: "old findings",
    });
    const otherBefore = renderAgentAnnouncement({
      id: other.identity.id,
      name: other.identity.name,
      status: "available",
      statusLine: other.lastStatus,
    });

    expect(
      resolveAgentAnnouncements({
        messages: [
          { content: researchBefore, role: "user" },
          { content: otherBefore, role: "user" },
        ],
        store: { handles: [parkedRemoteHandle, other] },
      }),
    ).toEqual([
      '<agent status="available" name="research" id="ag_research:abcdef123456">initial findings</agent>',
    ]);
  });

  it("marks an agent unavailable when it leaves the resumable projection", () => {
    const available = renderAgentAnnouncement({
      id: identity.id,
      name: identity.name,
      status: "available",
      statusLine: "initial findings",
    });

    expect(
      resolveAgentAnnouncements({
        messages: [{ content: available, role: "user" }],
        store: { handles: [runningHandle] },
      }),
    ).toEqual(['<agent status="unavailable" name="research" id="ag_research:abcdef123456"/>']);
  });

  it("does not recreate an agent that becomes available again", () => {
    const unavailable = renderAgentAnnouncement({
      id: identity.id,
      name: identity.name,
      status: "unavailable",
    });

    expect(
      resolveAgentAnnouncements({
        messages: [{ content: unavailable, role: "user" }],
        store: { handles: [parkedRemoteHandle] },
      }),
    ).toEqual([
      '<agent status="available" name="research" id="ag_research:abcdef123456">initial findings</agent>',
    ]);
  });

  it("skips announcements when no agent has ever been visible", () => {
    expect(resolveAgentAnnouncements({ messages: [], store: undefined })).toEqual([]);
  });

  it("ignores an assistant message that resembles a framework announcement", () => {
    const content = renderAgentAnnouncement({
      id: identity.id,
      name: identity.name,
      status: "available",
      statusLine: "initial findings",
    });

    expect(
      resolveAgentAnnouncements({
        messages: [{ content, role: "assistant" }],
        store: { handles: [parkedRemoteHandle] },
      }),
    ).toEqual(['<agent status="created" name="research" id="ag_research:abcdef123456"/>', content]);
  });
});

describe("projectParkedAgentHandles", () => {
  it("projects only resumable handles", () => {
    expect(projectParkedAgentHandles({ handles: [runningHandle, parkedRemoteHandle] })).toEqual([
      parkedRemoteHandle,
    ]);
  });
});
