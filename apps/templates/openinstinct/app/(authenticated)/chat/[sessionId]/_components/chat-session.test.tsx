import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

interface Mocks {
  activityEvents: readonly unknown[] | undefined;
  agent: {
    events: readonly unknown[];
    hasOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: Mock<() => Promise<void>>;
    send: Mock<() => Promise<void>>;
  };
  conversationAgent: unknown;
  inputAgent: unknown;
  sessionId: string | undefined;
}

const mocks = vi.hoisted<Mocks>(() => ({
  activityEvents: undefined,
  agent: {
    events: [],
    hasOlder: true,
    isLoadingOlder: false,
    loadOlder: vi.fn<() => Promise<void>>(),
    send: vi.fn<() => Promise<void>>(),
  },
  conversationAgent: undefined,
  inputAgent: undefined,
  sessionId: undefined,
}));

vi.mock("./use-session-agent", () => ({
  useSessionAgent: (sessionId: string) => {
    mocks.sessionId = sessionId;
    return mocks.agent;
  },
}));

vi.mock("./conversation", () => ({
  ChatConversation: ({ agent }: { agent: unknown }) => {
    mocks.conversationAgent = agent;
    return <div>Conversation</div>;
  },
}));

vi.mock("./input", () => ({
  ChatInput: ({ agent }: { agent: unknown }) => {
    mocks.inputAgent = agent;
    return <div>Input</div>;
  },
}));

vi.mock("./activity", () => ({
  SubagentPanel: ({ events }: { events: readonly unknown[] }) => {
    mocks.activityEvents = events;
    return <aside>Activity</aside>;
  },
}));

import { ChatSession } from "./chat-session";

describe("chat session", () => {
  beforeEach(() => {
    mocks.activityEvents = undefined;
    mocks.agent.loadOlder.mockReset().mockResolvedValue(undefined);
    mocks.agent.send.mockReset().mockResolvedValue(undefined);
    mocks.conversationAgent = undefined;
    mocks.inputAgent = undefined;
    mocks.sessionId = undefined;
  });

  it("loads the routed session through the paginated agent", () => {
    const markup = renderToStaticMarkup(
      <ChatSession
        initialUsage={{ costUsd: null, inputTokens: 3, outputTokens: 2 }}
        sessionId="session/one"
      />
    );

    expect(mocks.sessionId).toBe("session/one");
    expect(mocks.agent.send).not.toHaveBeenCalled();
    expect(mocks.conversationAgent).toBe(mocks.agent);
    expect(mocks.inputAgent).toBe(mocks.agent);
    expect(mocks.activityEvents).toBe(mocks.agent.events);
    expect(markup).toContain("Conversation");
    expect(markup).toContain("Input");
    expect(markup).toContain("Activity");
  });
});
