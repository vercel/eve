import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Card, CardText } from "#compiled/chat/index.js";
import { decodeSlackApiBody } from "#public/channels/slack/api-encoding.js";
import { buildSlackBinding, callSlackApi } from "#public/channels/slack/api.js";

interface FetchCall {
  url: string;
  body: unknown;
  contentType: string | null;
}

function buildFetchMock(): { fetch: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const contentType = init?.headers ? new Headers(init.headers).get("content-type") : null;
    const parsedBody = decodeSlackApiBody(init?.body, contentType);
    calls.push({ url, body: parsedBody, contentType });

    if (url === "https://slack.com/api/files.getUploadURLExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          upload_url: "https://files.slack.com/upload/abc",
          file_id: `F${calls.length}`,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://files.slack.com/upload/")) {
      return new Response("OK", { status: 200 });
    }
    if (url === "https://slack.com/api/files.completeUploadExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          files: [{ id: "F1", title: "report.csv" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://slack.com/api/conversations.replies") {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              text: "Hello from user",
              ts: "1700000000.123456",
              thread_ts: "1700000000.000001",
              user: "U01",
              files: [
                {
                  id: "F1",
                  name: "report.csv",
                  mimetype: "text/csv",
                  url_private: "https://files.slack.com/a/b/report.csv",
                  size: 128,
                },
              ],
            },
            {
              text: "Hello from bot",
              ts: "1700000001.000000",
              thread_ts: "1700000000.000001",
              bot_id: "B01",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://slack.com/api/conversations.open") {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D777" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch, calls };
}

describe("callSlackApi encoding", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Slack accepts form encoding on every endpoint but JSON on only a
  // subset (conversations.replies rejects JSON). Lock in form so the
  // partial-JSON endpoints don't silently break again.
  it("sends every Slack API call as application/x-www-form-urlencoded", async () => {
    for (const operation of [
      "conversations.replies",
      "conversations.history",
      "chat.postMessage",
      "chat.postEphemeral",
      "files.getUploadURLExternal",
      "files.completeUploadExternal",
      "assistant.threads.setStatus",
    ]) {
      await callSlackApi({
        botToken: "xoxb-test",
        operation,
        body: { channel: "C01", ts: "1700000000.000001" },
      });
    }

    expect(mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const call of mock.calls) {
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
    }
  });
});

describe("SlackHandle.uploadFiles", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the 3-step Slack upload flow per file", async () => {
    const { slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: "T01",
    });

    const bytes = new TextEncoder().encode("hello,world\n1,2\n").buffer as ArrayBuffer;

    const result = await slack.uploadFiles(
      [{ data: bytes, filename: "report.csv", mimeType: "text/csv" }],
      { initialComment: "*Report*" },
    );

    expect(result.fileIds).toEqual(["F1"]);

    const urls = mock.calls.map((c) => c.url);
    expect(urls).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/abc",
      "https://slack.com/api/files.completeUploadExternal",
    ]);

    const getUrlBody = mock.calls[0]!.body as { filename: string; length: string };
    expect(getUrlBody.filename).toBe("report.csv");
    expect(getUrlBody.length).toBe(String(bytes.byteLength));

    expect(mock.calls[1]!.contentType).toBe("application/octet-stream");

    const completeBody = mock.calls[2]!.body as {
      channel_id: string;
      thread_ts: string;
      initial_comment: string;
      files: { id: string; title: string }[];
    };
    expect(completeBody.channel_id).toBe("C01");
    expect(completeBody.thread_ts).toBe("1.0");
    expect(completeBody.initial_comment).toBe("*Report*");
    expect(completeBody.files).toEqual([{ id: "F1", title: "report.csv" }]);
  });

  it("returns an empty result for zero files", async () => {
    const { slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const result = await slack.uploadFiles([]);
    expect(result.fileIds).toEqual([]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("accepts options.channelId and options.threadTs overrides", async () => {
    const { slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await slack.uploadFiles([{ data: Buffer.from([1, 2, 3]), filename: "x.bin" }], {
      channelId: "CXYZ",
      threadTs: "9.9",
    });

    const completeBody = mock.calls.at(-1)!.body as {
      channel_id: string;
      thread_ts: string;
    };
    expect(completeBody.channel_id).toBe("CXYZ");
    expect(completeBody.thread_ts).toBe("9.9");
  });

  it("propagates errors from files.getUploadURLExternal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await expect(
      slack.uploadFiles([{ data: Buffer.from([1]), filename: "x.bin" }]),
    ).rejects.toThrow("rate_limited");
  });
});

describe("SlackThread.post with files", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("{ markdown, files } produces a single Slack message via completeUploadExternal", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      markdown: "**Report attached**",
      files: [{ data: Buffer.from([1, 2]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const postMessageCall = mock.calls.find(
      (c) => c.url === "https://slack.com/api/chat.postMessage",
    );
    expect(postMessageCall).toBeUndefined();

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    )!;
    expect((complete.body as { initial_comment: string }).initial_comment).toBe(
      "*Report attached*",
    );
  });

  it("{ card, files } posts the card via chat.postMessage and uploads files separately", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      card: Card({ children: [CardText("Here's the data:")] }),
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeDefined();
    expect((post!.body as { blocks: unknown[] }).blocks).toBeDefined();

    const complete = mock.calls.find(
      (c) => c.url === "https://slack.com/api/files.completeUploadExternal",
    );
    expect(complete).toBeDefined();
    expect((complete!.body as { initial_comment?: string }).initial_comment).toBeUndefined();
    expect((complete!.body as { channel_id: string; thread_ts: string }).channel_id).toBe("C01");
    expect((complete!.body as { channel_id: string; thread_ts: string }).thread_ts).toBe("1.0");
  });
});

describe("SlackThread.refresh", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates recent messages with the eve-owned Slack thread shape", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1700000000.000001",
      teamId: undefined,
    });

    await thread.refresh();

    // conversations.replies rejects JSON; lock in the form encoding at
    // the public refresh surface so replies never get silently dropped.
    const repliesCall = mock.calls.find(
      (call) => call.url === "https://slack.com/api/conversations.replies",
    );
    expect(repliesCall?.contentType).toBe("application/x-www-form-urlencoded");

    expect(thread.recentMessages).toHaveLength(2);
    expect(thread.recentMessages[0]).toMatchObject({
      text: "Hello from user",
      markdown: "Hello from user",
      user: "U01",
      botId: undefined,
      ts: "1700000000.123456",
      threadTs: "1700000000.000001",
      isMe: false,
      raw: { files: [{ id: "F1" }] },
    });
    expect(thread.recentMessages[1]).toMatchObject({
      text: "Hello from bot",
      botId: "B01",
      ts: "1700000001.000000",
      threadTs: "1700000000.000001",
      isMe: true,
    });

    const firstMessage = thread.recentMessages[0]!;
    expect("id" in firstMessage).toBe(false);
    expect("attachments" in firstMessage).toBe(false);
    expect("author" in firstMessage).toBe(false);
    expect("metadata" in firstMessage).toBe(false);
  });
});

describe("SlackThread.postEphemeral", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts via chat.postEphemeral with user / channel / thread_ts", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.postEphemeral("U99", { text: "psst" });

    const call = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postEphemeral");
    expect(call).toBeDefined();
    const body = call!.body as { user: string; channel: string; thread_ts: string; text: string };
    expect(body.user).toBe("U99");
    expect(body.channel).toBe("C01");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toBe("psst");
  });
});

describe("SlackThread.postDirectMessage", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the IM conversation and posts to it without a thread_ts", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.postDirectMessage("U99", { text: "for your eyes only" });

    const open = mock.calls.find((c) => c.url === "https://slack.com/api/conversations.open");
    expect(open).toBeDefined();
    expect((open!.body as { users: string }).users).toBe("U99");

    const post = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(post).toBeDefined();
    const body = post!.body as { channel: string; thread_ts?: string; text: string };
    expect(body.channel).toBe("D777");
    expect(body.thread_ts).toBeUndefined();
    expect(body.text).toBe("for your eyes only");
    expect(posted.id).toBe("1700000001.000001");
  });
});

describe("auto-anchor on first post", () => {
  let mock: ReturnType<typeof buildFetchMock>;

  beforeEach(() => {
    mock = buildFetchMock();
    vi.stubGlobal("fetch", mock.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first chat.postMessage on an unanchored binding adopts its own ts as the thread root", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    expect(slack.threadTs).toBe("");

    const first = await thread.post("first reply");

    expect(first.id).toBe("1700000001.000001");
    expect(anchors).toEqual(["1700000001.000001"]);
    expect(slack.threadTs).toBe("1700000001.000001");

    // The first post itself lands at the channel root (no thread_ts in body)
    // because the anchor is set AFTER Slack assigns the ts.
    const firstCall = mock.calls.find((c) => c.url === "https://slack.com/api/chat.postMessage")!;
    expect((firstCall.body as { thread_ts?: string }).thread_ts).toBeUndefined();
  });

  it("subsequent posts thread under the anchored ts", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    await thread.post("first");
    await thread.post("second");
    await thread.post("third");

    const postCalls = mock.calls.filter((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(postCalls).toHaveLength(3);
    expect((postCalls[0]!.body as { thread_ts?: string }).thread_ts).toBeUndefined();
    expect((postCalls[1]!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
    expect((postCalls[2]!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
  });

  it("does not anchor when the binding already has a threadTs", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1700000000.000999",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.post("hello");

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("1700000000.000999");
  });

  it("does not anchor on postEphemeral", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.postEphemeral("U99", { text: "psst" });

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("");
  });

  it("does not anchor on a files-only post", async () => {
    const anchors: string[] = [];
    const { thread, slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await thread.post({
      markdown: "**Report attached**",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(anchors).toEqual([]);
    expect(slack.threadTs).toBe("");
  });

  it("enables startTyping after a post anchors the thread", async () => {
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    await thread.startTyping("Pre-anchor");
    expect(
      mock.calls.find((c) => c.url === "https://slack.com/api/assistant.threads.setStatus"),
    ).toBeUndefined();

    await thread.post("anchor");
    await thread.startTyping("Post-anchor");

    const setStatus = mock.calls.find(
      (c) => c.url === "https://slack.com/api/assistant.threads.setStatus",
    );
    expect(setStatus).toBeDefined();
    expect((setStatus!.body as { thread_ts: string }).thread_ts).toBe("1700000001.000001");
  });

  it("invokes onThreadTsChanged exactly once even on concurrent first-posts", async () => {
    const anchors: string[] = [];
    const { thread } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await Promise.all([thread.post("a"), thread.post("b"), thread.post("c")]);

    expect(anchors).toHaveLength(1);
  });
});
