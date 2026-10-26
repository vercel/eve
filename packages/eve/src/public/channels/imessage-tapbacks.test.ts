import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { getEmoji, Message, type ReactionEvent } from "#compiled/chat/index.js";
import {
  dispatchIMessageTapbacks,
  iMessageTapbackText,
  iMessageTapbackTool,
  toIMessageTapback,
} from "#public/channels/imessage-tapbacks.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const author = { fullName: "Alice", isBot: false, isMe: false, userId: "alice", userName: "alice" };

function message(text: string): Message {
  return new Message({
    attachments: [],
    author,
    formatted: { type: "root", children: [] },
    id: "message-id",
    metadata: { dateSent: new Date(0), edited: false },
    raw: {},
    text,
    threadId: "thread-id",
  });
}

function reaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return {
    adapter: {} as ReactionEvent["adapter"],
    added: true,
    emoji: getEmoji("heart"),
    messageId: "message-id",
    raw: {},
    rawEmoji: "❤️",
    thread: { toJSON: () => ({ id: "thread-id" }) } as never,
    threadId: "thread-id",
    user: author,
    ...overrides,
  };
}

describe("iMessage tapbacks", () => {
  it("names standard tapbacks the same way for every provider", () => {
    expect(
      toIMessageTapback(reaction({ emoji: getEmoji("thumbs_up"), rawEmoji: "like" })).tapback,
    ).toBe("like");
    expect(
      toIMessageTapback(reaction({ emoji: getEmoji("exclamation"), rawEmoji: "‼️" })).tapback,
    ).toBe("emphasize");
    expect(toIMessageTapback(reaction({ emoji: getEmoji("🎉"), rawEmoji: "🎉" })).tapback).toBe(
      "🎉",
    );
  });

  it("shows tapbacks to the model the way iMessage writes them as text", () => {
    const base = toIMessageTapback(reaction({ message: message("See you at 7") }));

    expect(iMessageTapbackText(base)).toBe("Tapback: Loved “See you at 7”");
    expect(iMessageTapbackText({ ...base, added: false })).toBe(
      "Tapback: Removed a love tapback from “See you at 7”",
    );
    expect(iMessageTapbackText({ ...base, message: undefined, tapback: "🎉" })).toBe(
      "Tapback: Reacted 🎉 to a message",
    );
  });

  it("sends accepted tapbacks and skips the agent's own and declined ones", async () => {
    const onReaction = vi.fn();
    const send = vi.fn();
    const bridge = { bot: { onReaction }, send } as never;
    const onTapback = vi.fn((_ctx, tapback: { tapback: string }) =>
      tapback.tapback === "love" ? { auth: null, context: ["ctx"] } : null,
    );
    dispatchIMessageTapbacks(bridge, onTapback);
    const handler = onReaction.mock.calls[0]?.[0] as (event: ReactionEvent) => Promise<void>;

    await handler(reaction({ user: { ...author, isMe: true } }));
    await handler(reaction({ emoji: getEmoji("thumbs_up"), rawEmoji: "like" }));
    await handler(reaction());

    expect(onTapback).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Tapback: Loved a message", {
      auth: null,
      context: ["ctx"],
      thread: { id: "thread-id" },
      title: undefined,
    });
  });

  it("fetches the reacted message when the event leaves it out, and passes the hook's answer for that message", async () => {
    const onReaction = vi.fn();
    const send = vi.fn();
    dispatchIMessageTapbacks({ bot: { onReaction }, send } as never, (_ctx, tapback) =>
      tapback.tapback === "like" && tapback.message?.text === "See you at 7"
        ? { answer: "approve", auth: null }
        : null,
    );
    const handler = onReaction.mock.calls[0]?.[0] as (event: ReactionEvent) => Promise<void>;
    const fetchMessage = vi.fn(async () => message("See you at 7"));

    await handler(
      reaction({
        adapter: { fetchMessage } as never,
        emoji: getEmoji("thumbs_up"),
        rawEmoji: "like",
      }),
    );

    expect(fetchMessage).toHaveBeenCalledWith("thread-id", "message-id");
    expect(send).toHaveBeenCalledWith(
      "Tapback: Liked “See you at 7”",
      expect.objectContaining({
        auth: null,
        inputAnswer: { messageId: "message-id", optionId: "approve" },
      }),
    );
  });

  describe("tapback tool", () => {
    const channel = { __kind: "eve:channel", adapter: { kind: "channel:photon" }, routes: [] };

    function setup(state: Record<string, unknown>, kind = "channel:photon") {
      const addReaction = vi.fn();
      const sendEmoji = vi.fn();
      const bot = { getAdapter: vi.fn(() => ({ addReaction })), initialize: vi.fn() };
      const tool = iMessageTapbackTool({
        adapterName: "imessage",
        bot: bot as never,
        channel: channel as never,
        channelLabel: "Photon iMessage",
        sendEmoji,
      });
      const ctx = new ContextContainer();
      ctx.set(ChannelKey, { kind, state } as never);
      const run = (tapback: string) =>
        contextStorage.run(ctx, async () => tool.execute({ tapback } as never, {} as never));
      return { addReaction, bot, run, sendEmoji };
    }

    const conversation = { latestMessageId: "latest-id", thread: { id: "imessage:chat" } };

    it("reacts to the latest message in the session's conversation", async () => {
      const { addReaction, bot, run } = setup({
        latestMessageId: "latest-id",
        thread: { id: "imessage:chat" },
      });

      await expect(run("love")).resolves.toBe("Sent a love tapback.");
      expect(bot.getAdapter).toHaveBeenCalledWith("imessage");
      expect(addReaction).toHaveBeenCalledWith("imessage:chat", "latest-id", "love");
    });

    it("sends a standard tapback's own emoji as that tapback", async () => {
      const { addReaction, run, sendEmoji } = setup(conversation);

      await expect(run("👍")).resolves.toBe("Sent a like tapback.");
      expect(addReaction).toHaveBeenCalledWith("imessage:chat", "latest-id", "like");
      expect(sendEmoji).not.toHaveBeenCalled();
    });

    it("sends any other single emoji as an emoji tapback", async () => {
      const { addReaction, run, sendEmoji } = setup(conversation);

      await expect(run("🎉")).resolves.toBe("Sent a 🎉 tapback.");
      await run("👩‍💻");
      expect(sendEmoji).toHaveBeenNthCalledWith(
        1,
        { addReaction },
        "imessage:chat",
        "latest-id",
        "🎉",
      );
      expect(sendEmoji).toHaveBeenNthCalledWith(
        2,
        { addReaction },
        "imessage:chat",
        "latest-id",
        "👩‍💻",
      );
    });

    it.each(["party", "🎉🎉", "a"])("rejects %j", async (tapback) => {
      const { addReaction, run, sendEmoji } = setup(conversation);

      await expect(run(tapback)).rejects.toThrow(`Unknown tapback "${tapback}"`);
      expect(addReaction).not.toHaveBeenCalled();
      expect(sendEmoji).not.toHaveBeenCalled();
    });

    it("refuses sessions from another channel", async () => {
      const { addReaction, run } = setup(
        { latestMessageId: "latest-id", thread: { id: "slack:chat" } },
        "channel:slack",
      );

      await expect(run("love")).rejects.toThrow(
        "Tapbacks work only in a conversation that came through the Photon iMessage channel.",
      );
      expect(addReaction).not.toHaveBeenCalled();
    });

    it("explains when there is nothing to react to", async () => {
      const { run } = setup({ thread: { id: "imessage:chat" } });

      await expect(run("love")).rejects.toThrow("There is no message in this conversation");
    });
  });
});
