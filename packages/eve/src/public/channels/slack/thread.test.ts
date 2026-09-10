import { describe, expect, it, vi } from "vitest";

import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import {
  hydrateCopiedSlackMessage,
  loadThreadContextMessages,
} from "#public/channels/slack/thread.js";

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

function slackMessage(text: string): SlackMessage {
  return {
    attachments: [],
    author: undefined,
    channelId: "C_DESTINATION",
    markdown: text,
    raw: { channel_type: "channel", text },
    teamId: "T01",
    text,
    threadTs: "1700000000.000001",
    ts: "1700000000.000001",
  };
}

describe("hydrateCopiedSlackMessage", () => {
  it("waits for and uses a copied Slack message unfurl", async () => {
    const initial = slackMessage(
      ":crosspost: <https://example.slack.com/archives/C012ABC/p1700000000000100>",
    );
    const messages: SlackThreadMessage[] = [];
    const refresh = vi.fn(async () => {
      messages.push(
        threadMessage({
          text: ":crosspost:\nThe copied report body",
          threadTs: initial.threadTs,
          ts: initial.ts,
        }),
      );
    });
    const wait = vi.fn(async () => {});

    await expect(
      hydrateCopiedSlackMessage({ recentMessages: messages, refresh }, initial, wait),
    ).resolves.toMatchObject({
      markdown: ":crosspost:\nThe copied report body",
      raw: { channel_type: "channel" },
      text: ":crosspost:\nThe copied report body",
    });
    expect(wait).toHaveBeenCalledWith(500);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("recognizes a copied permalink after a leading app mention", async () => {
    const initial = slackMessage(
      "<@U012BOT> :crosspost: <https://example.enterprise.slack.com/archives/C012ABC/p1700000000000100?thread_ts=1700000000.000100>",
    );
    const refresh = vi.fn(async () => {});

    await hydrateCopiedSlackMessage({ recentMessages: [], refresh }, initial, async () => {});

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh native forwards or ordinary Slack links", async () => {
    const refresh = vi.fn(async () => {});
    const wait = vi.fn(async () => {});

    for (const text of [
      ":crosspost:\nThe forwarded report body",
      "Please review <https://example.slack.com/archives/C012ABC/p1700000000000100>",
    ]) {
      const message = slackMessage(text);
      await expect(
        hydrateCopiedSlackMessage({ recentMessages: [], refresh }, message, wait),
      ).resolves.toBe(message);
    }

    expect(wait).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves the original message when the unfurl is still unavailable", async () => {
    const initial = slackMessage(
      ":crosspost: <https://example.slack.com/archives/C012ABC/p1700000000000100>",
    );
    const refresh = vi.fn(async () => {});

    await expect(
      hydrateCopiedSlackMessage({ recentMessages: [], refresh }, initial, async () => {}),
    ).resolves.toBe(initial);
  });
});

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

  it("reuses messages already loaded by another thread helper", async () => {
    const messages = [
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000001", text: "root" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000002", text: "prior" }),
      threadMessage({ threadTs: "1700000000.000001", ts: "1700000000.000003", text: "current" }),
    ];
    const refresh = vi.fn(async () => {});
    const thread = {
      recentMessages: messages,
      refresh,
    };

    await expect(
      loadThreadContextMessages(thread, {
        threadTs: "1700000000.000001",
        ts: "1700000000.000003",
      }),
    ).resolves.toEqual([messages[0], messages[1]]);
    expect(refresh).not.toHaveBeenCalled();
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
