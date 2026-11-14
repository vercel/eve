import { afterEach, describe, expect, it, vi } from "vitest";
import { slackRenderingHarness } from "#internal/testing/slack-rendering-harness.js";
import { postCompletedSlackReply } from "#public/channels/slack/index.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSlack(respond: (operation: string) => Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) =>
      Response.json(respond(String(url).replace("https://slack.com/api/", ""))),
    ),
  );
}

function threadChannel(threadTs: string) {
  return slackRenderingHarness(slackChannel({ credentials: { botToken: "xoxb-test" } }), {
    channelId: "C01",
    threadTs,
    teamId: "T01",
  }).channel;
}

describe("postCompletedSlackReply", () => {
  it("returns the message it posts for the blocks", async () => {
    stubSlack(() => ({ ok: true, ts: "1700000001.000001" }));
    const posted = await postCompletedSlackReply(threadChannel("1700000000.000001"), {
      blocks: [{ type: "markdown", text: "hello" }],
      markdown: "hello",
    });
    expect(posted?.id).toBe("1700000001.000001");
  });

  it("returns the Markdown message when Slack refuses the blocks", async () => {
    let posts = 0;
    stubSlack((operation) => {
      if (operation !== "chat.postMessage") return { ok: true };
      posts += 1;
      return posts === 1
        ? { ok: false, error: "msg_blocks_too_long" }
        : { ok: true, ts: "1700000001.000002" };
    });
    const posted = await postCompletedSlackReply(threadChannel("1700000000.000001"), {
      blocks: [{ type: "markdown", text: "hello" }],
      markdown: "hello",
    });
    expect(posts).toBe(2);
    expect(posted?.id).toBe("1700000001.000002");
  });

  it("returns undefined when the thread's root is gone", async () => {
    stubSlack((operation) =>
      operation === "chat.getPermalink"
        ? { ok: false, error: "message_not_found" }
        : { ok: true, ts: "1700000001.000003" },
    );
    expect(await postCompletedSlackReply(threadChannel("1700000000.000001"), "hello")).toBe(
      undefined,
    );
  });
});
