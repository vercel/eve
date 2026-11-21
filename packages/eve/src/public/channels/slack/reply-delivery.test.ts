import { describe, expect, it } from "vitest";
import type { SlackContext } from "#public/channels/slack/slackChannel.js";
import { postCompletedSlackReply } from "#public/channels/slack/reply-delivery.js";

function slackError(code: string): Error {
  return Object.assign(new Error(`Slack chat.postMessage failed: ${code}`), {
    response: { ok: false, error: code },
  });
}

function channelRejecting(blocksError: string, markdownError?: string) {
  const posts: unknown[] = [];
  const channel = {
    slack: { channelId: "", threadTs: "1.1", codeChannel: false },
    thread: {
      post: async (message: unknown) => {
        const isBlocks = typeof message === "object" && message !== null && "blocks" in message;
        if (isBlocks) throw slackError(blocksError);
        if (markdownError) throw slackError(markdownError);
        posts.push(message);
        return { id: "1.2" };
      },
    },
  } as SlackContext;
  return { channel, posts };
}

const reply = { blocks: [{ type: "markdown", text: "**hi**" }], markdown: "**hi**" };

describe("postCompletedSlackReply", () => {
  it("posts the Markdown when Slack fails the blocks with fatal_error", async () => {
    const { channel, posts } = channelRejecting("fatal_error");

    await postCompletedSlackReply(channel, reply);

    expect(posts).toEqual(["**hi**"]);
  });

  it("throws when the Markdown fallback also fails with fatal_error", async () => {
    const { channel, posts } = channelRejecting("fatal_error", "fatal_error");

    await expect(postCompletedSlackReply(channel, reply)).rejects.toThrow(/fatal_error/u);
    expect(posts).toEqual([]);
  });

  it("throws other Slack errors from the blocks without falling back", async () => {
    const { channel, posts } = channelRejecting("not_in_channel");

    await expect(postCompletedSlackReply(channel, reply)).rejects.toThrow(/not_in_channel/u);
    expect(posts).toEqual([]);
  });
});
