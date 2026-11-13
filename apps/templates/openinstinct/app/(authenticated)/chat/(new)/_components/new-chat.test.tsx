import type { useEveAgent } from "eve/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PromptInputMessage } from "@web/components/ai-elements/prompt-input";

type AgentOptions = Parameters<typeof useEveAgent>[0];

interface MockAgent {
  send: Mock<() => Promise<void>>;
}

interface Mocks {
  agent: MockAgent;
  options: AgentOptions | undefined;
  promptSubmit:
    | ((message: PromptInputMessage) => void | Promise<void>)
    | undefined;
  saveChat: Mock<
    (input: { sessionId: string; title: string | undefined }) => Promise<void>
  >;
  routerReplace: Mock<(href: string) => void>;
}

const mocks = vi.hoisted<Mocks>(() => ({
  agent: {
    send: vi.fn<() => Promise<void>>(),
  },
  options: undefined,
  promptSubmit: undefined,
  saveChat:
    vi.fn<
      (input: { sessionId: string; title: string | undefined }) => Promise<void>
    >(),
  routerReplace: vi.fn<(href: string) => void>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}));

vi.mock("eve/react", () => ({
  useEveAgent: (options: AgentOptions) => {
    mocks.options = options;
    return mocks.agent;
  },
}));

vi.mock("@web/trpc/client", () => ({
  api: {
    chats: { save: { useMutation: () => ({ mutateAsync: mocks.saveChat }) } },
  },
}));

vi.mock("@web/components/ai-elements/prompt-input", () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: ReactNode;
    onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  }) => {
    mocks.promptSubmit = onSubmit;
    return <form>{children}</form>;
  },
  PromptInputBody: ({ children }: { children: ReactNode }) => children,
  PromptInputFooter: ({ children }: { children: ReactNode }) => children,
  PromptInputSubmit: () => <button type="submit">Send</button>,
  PromptInputTextarea: () => <textarea />,
  PromptInputTools: () => null,
}));

import { NewChat } from "./new-chat";

describe("new chat", () => {
  beforeEach(() => {
    mocks.agent.send.mockReset().mockResolvedValue(undefined);
    mocks.options = undefined;
    mocks.promptSubmit = undefined;
    mocks.saveChat.mockReset().mockResolvedValue(undefined);
    mocks.routerReplace.mockReset();
  });

  it("navigates the first prompt into its session route once", async () => {
    const emptyMarkup = renderToStaticMarkup(<NewChat />);
    expect(emptyMarkup).toContain("<form");

    await mocks.promptSubmit?.({ files: [], text: "Inspect my workspace" });
    expect(mocks.agent.send).toHaveBeenCalledWith("Inspect my workspace");

    mocks.options?.onSessionChange?.({
      sessionId: "session/one",
      streamIndex: 0,
    });
    expect(mocks.saveChat).toHaveBeenCalledWith({
      sessionId: "session/one",
      title: "Inspect my workspace",
    });
    await vi.waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/chat/session%2Fone");
    });

    mocks.options?.onSessionChange?.({
      sessionId: "session/one",
      streamIndex: 1,
    });
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
  });
});
