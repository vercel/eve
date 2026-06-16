import { describe, expect, it } from "vitest";

import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import { loadThreadContextMessages } from "#public/channels/slack/thread.js";

function threadMessage(input: {
  readonly isMe?: boolean;
  readonly threadTs: string;
  readonly ts: string;
  readonly text?: string;
}): SlackThreadMessage {
  return {
    botId: undefined,
    isMe: input.isMe ?? false,
    markdown: input.text ?? input.ts,
    raw: {},
    text: input.text ?? input.ts,
    threadTs: input.threadTs,
    ts: input.ts,
    user: "U01",
  };
}

describe("loadThreadContextMessages", () => {
  it("returns an empty array without refreshing when the message is the thread root", async () => {
    const thread = {
      recentMessages: [
        threadMessage({
          threadTs: "1700000000.000001",
          ts: "1700000000.000001",
        }),
      ],
      refresh: async () => {
        throw new Error("must not refresh root messages");
      },
    };

    await expect(
      loadThreadContextMessages(thread, {
        threadTs: "1700000000.000001",
        ts: "1700000000.000001",
      }),
    ).resolves.toEqual([]);
  });

  it("refreshes thread replies and returns prior messages by default", async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000002", text: "prior" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "current" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000004", text: "after" }),
      threadMessage({ threadTs: "1700000000.000009", ts: "1700000000.000010", text: "wrong" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(thread, {
        threadTs: "1700000000.000001",
        ts: "1700000000.000003",
      }),
    ).resolves.toEqual([messages[0], messages[1]]);
  });

  it('with since: "last-agent-reply" returns only messages after the last agent reply', async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({
        isMe: true,
        threadTs: "1700000000.000001",
        ts: "1700000000.000002",
        text: "agent reply",
      }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "new info" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000004", text: "current" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(
        thread,
        {
          threadTs: "1700000000.000001",
          ts: "1700000000.000004",
        },
        { since: "last-agent-reply" },
      ),
    ).resolves.toEqual([messages[2]]);
  });

  it("with a since predicate returns only messages after the custom boundary", async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000002", text: "boundary" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "new info" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000004", text: "current" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(
        thread,
        {
          threadTs: "1700000000.000001",
          ts: "1700000000.000004",
        },
        {
          since: (entry) => entry.text === "boundary",
        },
      ),
    ).resolves.toEqual([messages[2]]);
  });

  it("with a since predicate returns all prior messages when no message matches", async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000002", text: "prior" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "current" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(
        thread,
        {
          threadTs: "1700000000.000001",
          ts: "1700000000.000003",
        },
        { since: (entry) => entry.isMe },
      ),
    ).resolves.toEqual([messages[0], messages[1]]);
  });

  it("with a since predicate uses the last matching message as the boundary", async () => {
    const messages = [
      threadMessage({
        isMe: true,
        threadTs: "1700000000.000001",
        ts: "1700000000.000001",
        text: "first boundary",
      }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000002", text: "older" }),
      threadMessage({
        isMe: true,
        threadTs: "1700000000.000001",
        ts: "1700000000.000003",
        text: "last boundary",
      }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000004", text: "new info" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000005", text: "current" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(
        thread,
        {
          threadTs: "1700000000.000001",
          ts: "1700000000.000005",
        },
        { since: (entry) => entry.isMe },
      ),
    ).resolves.toEqual([messages[3]]);
  });

  it("with a since predicate returns an empty array when the last match is adjacent", async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({
        isMe: true,
        threadTs: "1700000000.000001",
        ts: "1700000000.000002",
        text: "boundary",
      }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "current" }),
    ];
    const thread = {
      recentMessages: messages,
      refresh: async () => {},
    };

    await expect(
      loadThreadContextMessages(
        thread,
        {
          threadTs: "1700000000.000001",
          ts: "1700000000.000003",
        },
        { since: (entry) => entry.isMe },
      ),
    ).resolves.toEqual([]);
  });
});
