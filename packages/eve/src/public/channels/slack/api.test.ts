import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Card, CardText } from "#compiled/chat/index.js";
import { mockSlack, type MockSlack } from "#internal/testing/mocks/mock-slack.js";
import type {
  SlackApiMethod,
  SlackApiResponseFor,
} from "#internal/testing/mocks/slack-api-contract.js";
import { buildSlackBinding, buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import {
  callSlackApi,
  callSlackApiJson,
  resolveSlackApiUrl,
  resolveSlackBotToken,
  SlackApiError,
  type SlackBotTokenContext,
} from "#public/channels/slack/api-transport.js";

/** Thread root every refresh test hangs its replies off. */
const THREAD_TS = "1700000000.000001";

/**
 * Declares the handful of methods a binding drives when a routing test
 * exercises post / ephemeral / typing / raw-request in one go.
 */
function allowBindingCalls(slack: MockSlack): void {
  slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
  slack.allow("chat.postEphemeral").andReturn({ ok: true, message_ts: "1700.2" });
  slack.allow("assistant.threads.setStatus").andReturn({ ok: true });
  slack.allow("auth.test").andReturn({ ok: true });
}

/**
 * Declares what `conversations.replies` returns for this thread. The
 * messages are the raw Slack payloads the parser under test reads.
 */
function allowReplies(slack: MockSlack, messages: readonly Record<string, unknown>[]): void {
  slack.allow("conversations.replies").andReturn({ ok: true, messages });
}

/**
 * Declares Slack's three-leg external upload handshake, allocating the
 * given file ids in order. Completion echoes back the files it was sent,
 * which is what production reads the returned id out of.
 */
function allowUpload(slack: MockSlack, fileIds: readonly string[] = ["F1"]): void {
  const pending = [...fileIds];
  slack.allow("files.getUploadURLExternal").andRespond(() => {
    const id = pending.shift();
    // A violation, so it still surfaces on the paths that swallow a
    // rejected fetch.
    if (id === undefined) {
      slack.reject("more files were uploaded than allowUpload declared ids for");
    }
    return { ok: true, upload_url: slack.uploadUrl(id), file_id: id };
  });
  slack
    .allow("files.completeUploadExternal")
    .andRespond((body) => ({ ok: true, files: body.files }));
}

describe("callSlackApi encoding", () => {
  // Slack accepts form encoding on every endpoint but JSON on only
  // some (conversations.replies rejects JSON), so eve form-encodes
  // everything bar the two JSON-only surfaces.
  it("sends every Slack API call as application/x-www-form-urlencoded", async () => {
    const slack = mockSlack();
    const responses = {
      "assistant.threads.setStatus": { ok: true },
      "chat.postEphemeral": { ok: true, message_ts: "1700.2" },
      "chat.postMessage": { ok: true, ts: "1700.1" },
      "conversations.replies": { ok: true, messages: [] },
      "files.completeUploadExternal": { ok: true, files: [{ id: "F1" }] },
      "files.getUploadURLExternal": { ok: true, file_id: "F1", upload_url: "https://upload/F1" },
    } satisfies { [M in SlackApiMethod]?: SlackApiResponseFor<M> };
    const operations = Object.keys(responses) as (keyof typeof responses)[];
    for (const operation of operations) {
      slack.allow(operation).andReturn(responses[operation]);
    }

    for (const operation of operations) {
      await callSlackApi({
        botToken: "xoxb-test",
        operation,
        body: { channel: "C01", ts: THREAD_TS },
        fetch: slack.fetch,
      });
    }

    expect(slack.calls).toHaveLength(6);
    for (const call of slack.calls) {
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
    }
    // The double rejects an unencoded or unsigned call, so this covers
    // a method added to the list later as well.
    slack.assertNoViolations();
  });
});

describe("SlackHandle.uploadFiles", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack();
  });

  it("runs the 3-step Slack upload flow per file", async () => {
    allowUpload(slack);
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: "T01",
    });

    const bytes = new TextEncoder().encode("hello,world\n1,2\n").buffer as ArrayBuffer;

    const result = await binding.slack.uploadFiles(
      [{ data: bytes, filename: "report.csv", mimeType: "text/csv" }],
      { initialComment: "*Report*" },
    );

    expect(result.fileIds).toEqual(["F1"]);

    expect(slack.calls.map((call) => call.method)).toEqual([
      "files.getUploadURLExternal",
      "files.upload",
      "files.completeUploadExternal",
    ]);

    const getUrlBody = slack.bodyOf("files.getUploadURLExternal");
    expect(getUrlBody.filename).toBe("report.csv");
    expect(getUrlBody.length).toBe(String(bytes.byteLength));

    expect(slack.calls[1]!.contentType).toBe("application/octet-stream");

    const completeBody = slack.bodyOf("files.completeUploadExternal");
    expect(completeBody.channel_id).toBe("C01");
    expect(completeBody.thread_ts).toBe("1.0");
    expect(completeBody.initial_comment).toBe("*Report*");
    expect(completeBody.files).toEqual([{ id: "F1", title: "report.csv" }]);

    // The handshake only coheres if the bytes Slack was promised are the
    // bytes it actually received.
    expect(slack.uploadedBytes()).toEqual([new Uint8Array(bytes)]);
  });

  it("returns an empty result for zero files", async () => {
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const result = await binding.slack.uploadFiles([]);
    expect(result.fileIds).toEqual([]);
    // Nothing is stubbed, so any call at all would have failed loudly.
    expect(slack.calls).toEqual([]);
  });

  it("accepts options.channelId and options.threadTs overrides", async () => {
    allowUpload(slack);
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await binding.slack.uploadFiles([{ data: Buffer.from([1, 2, 3]), filename: "x.bin" }], {
      channelId: "CXYZ",
      threadTs: "9.9",
    });

    expect(slack.bodyOf("files.completeUploadExternal")).toMatchObject({
      channel_id: "CXYZ",
      thread_ts: "9.9",
    });
  });

  it("propagates errors from files.getUploadURLExternal", async () => {
    allowUpload(slack);
    slack.failNext("files.getUploadURLExternal", "rate_limited");
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await expect(
      binding.slack.uploadFiles([{ data: Buffer.from([1]), filename: "x.bin" }]),
    ).rejects.toThrow("rate_limited");
    // It failed at the first leg, so no bytes were ever sent.
    expect(slack.uploadedBytes()).toEqual([]);
    expect(slack.callsTo("files.completeUploadExternal")).toEqual([]);
  });

  it("propagates an HTTP rate limit as a SlackApiError carrying the status", async () => {
    allowUpload(slack);
    slack.failNextHttp("files.getUploadURLExternal", { status: 429, retryAfter: 30 });
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const rejection = binding.slack.uploadFiles([{ data: Buffer.from([1]), filename: "x.bin" }]);

    await expect(rejection).rejects.toThrow(SlackApiError);
    await expect(rejection).rejects.toMatchObject({
      method: "files.getUploadURLExternal",
      status: 429,
    });
  });
});

describe("SlackThread.post with files", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack();
  });

  it("{ markdown, files } posts markdown before uploading files", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
    allowUpload(slack);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.post({
      markdown: [
        "**Report attached**",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Net | +488 |",
      ].join("\n"),
      files: [{ data: Buffer.from([1, 2]), filename: "report.csv", mimeType: "text/csv" }],
    });

    const post = slack.bodyOf("chat.postMessage");
    expect(post.markdown_text).toContain("| Metric | Value |");
    expect(post.thread_ts).toBe("1.0");

    // The returned id has to be the message ts, not anything from the
    // upload that followed it; the file id rides in its own field.
    expect(posted.id).toBe("1700.1");
    expect(posted.fileIds).toEqual(["F1"]);

    const complete = slack.bodyOf("files.completeUploadExternal");
    expect(complete.initial_comment).toBeUndefined();
    expect(complete.channel_id).toBe("C01");
    expect(complete.thread_ts).toBe("1.0");
  });

  it("{ text, files } keeps a single Slack upload comment", async () => {
    allowUpload(slack);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.post({
      text: "*Report attached*",
      files: [{ data: Buffer.from([1, 2]), filename: "report.csv", mimeType: "text/csv" }],
    });

    // chat.postMessage is not stubbed, so posting separately would have
    // failed outright: the text rides along as the upload's comment.
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
    expect(slack.bodyOf("files.completeUploadExternal")).toMatchObject({
      initial_comment: "*Report attached*",
      channel_id: "C01",
      thread_ts: "1.0",
    });

    // files.completeUploadExternal answers with file ids and no message
    // ts, so `id` stays empty. Handing back the file id instead would
    // put a value from the wrong namespace in a field callers pass to
    // chat.update.
    expect(posted.id).toBe("");
    expect(posted.fileIds).toEqual(["F1"]);
  });

  it("{ card, files } posts the card via chat.postMessage and uploads files separately", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
    allowUpload(slack);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.post({
      card: Card({ children: [CardText("Here's the data:")] }),
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    // The card branch posts first, so its id is the ts Slack named.
    expect(posted.id).toBe("1700.1");
    expect(posted.fileIds).toEqual(["F1"]);

    expect(slack.bodyOf("chat.postMessage").blocks).toBeDefined();

    const complete = slack.bodyOf("files.completeUploadExternal");
    expect(complete.initial_comment).toBeUndefined();
    expect(complete.channel_id).toBe("C01");
    expect(complete.thread_ts).toBe("1.0");
  });
});

/**
 * Message `ts` values and file ids are separate Slack namespaces, and
 * {@link SlackPostedMessage} keeps them in separate fields.
 *
 * {@link SlackPostedMessage.id} is documented as the Slack message `ts`,
 * which is what a follow-up `chat.update` needs, and the
 * `{ markdown | blocks | card } + files` branches return one. The
 * `{ text, files }` branch has none to give: it is delivered by
 * `files.completeUploadExternal`, which answers with file ids only. It
 * reports the empty `id` the field documents rather than a file id no
 * `chat.update` could address. Every variant reports its uploads under
 * `fileIds`.
 *
 * The stubs below give the message `ts` and the file ids
 * distinguishable values, which is what makes the difference visible.
 */
describe("SlackThread.post id namespace", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack();
  });

  it("keeps file ids out of id and reports them under fileIds", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
    allowUpload(slack, ["F1", "F2", "F3"]);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const fromText = await thread.post({
      text: "*Report attached*",
      files: [{ data: Buffer.from([1]), filename: "text.csv", mimeType: "text/csv" }],
    });
    const fromMarkdown = await thread.post({
      markdown: "**Report attached**",
      files: [{ data: Buffer.from([2]), filename: "markdown.csv", mimeType: "text/csv" }],
    });
    const fromCard = await thread.post({
      card: Card({ children: [CardText("Report attached")] }),
      files: [{ data: Buffer.from([3]), filename: "card.csv", mimeType: "text/csv" }],
    });

    // The sibling branches honor the contract: their id is the message
    // ts Slack returned, so a follow-up chat.update would land.
    expect(fromMarkdown.id).toBe("1700.1");
    expect(fromCard.id).toBe("1700.1");

    // { text, files } sends no chat.postMessage, so Slack never named a
    // message. It reports the empty id rather than the first staged
    // file id, which no chat.update could address.
    expect(fromText.id).toBe("");

    // The uploads stay reachable, under the field that says what they
    // are. Each post reports only the file it created.
    expect([fromText, fromMarkdown, fromCard].map((posted) => posted.fileIds)).toEqual([
      ["F1"],
      ["F2"],
      ["F3"],
    ]);
  });
});

describe("Slack outbound text", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack();
  });

  it("preserves literal at-prefixed tokens in markdown and text posts", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });
    const mention = thread.mentionUser("U012ABC456");

    expect(mention).toBe("<@U012ABC456>");
    await thread.post({ markdown: `bump @scope/package and ping ${mention}` });
    await thread.post({ text: "email @support or ping <@U012ABC456>" });

    expect(slack.callsTo("chat.postMessage")).toHaveLength(2);
    expect(slack.bodyOf("chat.postMessage", 0)).toMatchObject({
      markdown_text: "bump @scope/package and ping <@U012ABC456>",
    });
    expect(slack.bodyOf("chat.postMessage", 1)).toMatchObject({
      text: "email @support or ping <@U012ABC456>",
    });
  });

  it("preserves literal at-prefixed tokens in file upload comments", async () => {
    allowUpload(slack);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.post({
      text: "report for @scope/package and <@U012ABC456>",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(slack.bodyOf("files.completeUploadExternal")).toMatchObject({
      initial_comment: "report for @scope/package and <@U012ABC456>",
    });
  });
});

describe("Slack API failure surfaces", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack();
  });

  function bind() {
    return buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });
  }

  // The vendored Slack primitive has no retry logic, so a 429 fails
  // the call outright even though Slack said how long to wait.
  it("throws on HTTP 429 without honoring Retry-After", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
    slack.failNextHttp("chat.postMessage", {
      status: 429,
      retryAfter: 30,
      body: { ok: false, error: "rate_limited" },
    });
    const { thread } = bind();

    const rejection = thread.post("anything");
    await expect(rejection).rejects.toThrow(SlackApiError);
    await expect(rejection).rejects.toMatchObject({ method: "chat.postMessage", status: 429 });

    // One attempt: no back-off, no second try.
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });

  it.each(["msg_too_long", "invalid_blocks", "channel_not_found", "token_revoked"])(
    "raises a SlackApiError for a Slack-level %s on chat.postMessage",
    async (error) => {
      slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
      slack.failNext("chat.postMessage", error);
      const { thread } = bind();

      const rejection = thread.post({ markdown: "**too much**" });
      await expect(rejection).rejects.toThrow(SlackApiError);
      await expect(rejection).rejects.toMatchObject({
        method: "chat.postMessage",
        response: { ok: false, error },
      });
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
    },
  );

  it("raises channel_not_found from postEphemeral without delivering anything", async () => {
    slack.allow("chat.postEphemeral").andReturn({ ok: true, message_ts: "1700.1" });
    slack.failNext("chat.postEphemeral", "channel_not_found");
    const { thread } = bind();

    await expect(thread.postEphemeral("U99", { text: "psst" })).rejects.toThrow(
      "chat.postEphemeral failed: channel_not_found",
    );
  });

  it("raises invalid_auth from conversations.open before any DM is posted", async () => {
    slack.allow("conversations.open").andReturn({ ok: true, channel: { id: "D99" } });
    slack.failNext("conversations.open", "invalid_auth");
    const { thread } = bind();

    await expect(thread.postDirectMessage("U99", { text: "for your eyes only" })).rejects.toThrow(
      /invalid_auth/,
    );
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });

  // The typing indicator is a UX nicety, so eve swallows its failures:
  // a revoked token silently leaves the thread with no status rather
  // than failing the turn.
  it("swallows a revoked token on the typing indicator", async () => {
    slack.allow("assistant.threads.setStatus").andReturn({ ok: true });
    slack.failNext("assistant.threads.setStatus", "token_revoked");
    const { thread } = bind();

    await expect(thread.startTyping("Working...")).resolves.toBeUndefined();
    expect(slack.callsTo("assistant.threads.setStatus")).toHaveLength(1);
    slack.assertNoViolations();
  });

  it("leaves the staged bytes orphaned when completeUploadExternal fails", async () => {
    allowUpload(slack);
    slack.failNext("files.completeUploadExternal", "invalid_arguments");
    const binding = bind();

    await expect(
      binding.slack.uploadFiles([{ data: Buffer.from([1, 2]), filename: "x.bin" }]),
    ).rejects.toThrow("invalid_arguments");

    // The bytes landed, but Slack never shared them: the upload leg ran
    // and the completion that would have published it failed.
    expect(slack.uploadedBytes()).toEqual([new Uint8Array([1, 2])]);
    expect(slack.callsTo("files.completeUploadExternal")).toHaveLength(1);
  });

  // `fileIds` is built from the ids eve staged and never reconciled
  // against the files Slack says it completed, so a partial completion
  // reaches the caller as a full success.
  it("reports a partial completeUploadExternal as a full success", async () => {
    allowUpload(slack, ["F1", "F2"]);
    // Slack completing only one of the two files it was sent.
    slack.allow("files.completeUploadExternal").andReturn({ ok: true, files: [{ id: "F1" }] });
    const binding = bind();

    const result = await binding.slack.uploadFiles([
      { data: Buffer.from([1]), filename: "kept.bin" },
      { data: Buffer.from([2]), filename: "dropped.bin" },
    ]);

    expect(result.fileIds).toEqual(["F1", "F2"]);
    expect((result.raw.files as { id: string }[]).map((file) => file.id)).toEqual(["F1"]);
  });
});

describe("SlackThread.refresh", () => {
  let slack: MockSlack;

  /** Declares the two-message thread most refresh assertions read back. */
  function allowDefaultThread(api: MockSlack): void {
    allowReplies(api, [
      {
        text: "Hello from user",
        ts: "1700000000.123456",
        thread_ts: THREAD_TS,
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
        thread_ts: THREAD_TS,
        bot_id: "B01",
      },
    ]);
  }

  beforeEach(() => {
    slack = mockSlack();
  });

  it("hydrates recent messages with the eve-owned Slack thread shape", async () => {
    allowDefaultThread(slack);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: undefined,
    });

    await thread.refresh();

    // conversations.replies rejects JSON; lock in the form encoding at
    // the public refresh surface so replies never get silently dropped.
    expect(slack.callsTo("conversations.replies")[0]?.contentType).toBe(
      "application/x-www-form-urlencoded",
    );

    expect(thread.recentMessages).toHaveLength(2);
    expect(thread.recentMessages[0]).toMatchObject({
      text: "Hello from user",
      markdown: "Hello from user",
      user: "U01",
      botId: undefined,
      ts: "1700000000.123456",
      threadTs: THREAD_TS,
      isMe: false,
      raw: { files: [{ id: "F1" }] },
    });
    expect(thread.recentMessages[1]).toMatchObject({
      text: "Hello from bot",
      botId: "B01",
      ts: "1700000001.000000",
      threadTs: THREAD_TS,
      isMe: false,
    });

    const firstMessage = thread.recentMessages[0]!;
    expect("id" in firstMessage).toBe(false);
    expect("attachments" in firstMessage).toBe(false);
    expect("author" in firstMessage).toBe(false);
    expect("metadata" in firstMessage).toBe(false);
  });

  it("extracts Block Kit and legacy attachment content for text-less replies", async () => {
    allowReplies(slack, [
      {
        text: "",
        ts: "1700000000.123456",
        thread_ts: THREAD_TS,
        bot_id: "B01",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Alert:* Service latency is high" } },
          { type: "section", fields: [{ type: "mrkdwn", text: "Region: us-east-1" }] },
        ],
        attachments: [{ title: "Runbook", text: "Restart the pods." }],
      },
    ]);

    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: undefined,
    });

    await thread.refresh();

    const message = thread.recentMessages[0]!;
    expect(message.markdown).toContain("Service latency is high");
    expect(message.markdown).toContain("Region: us-east-1");
    expect(message.markdown).toContain("Runbook");
    expect(message.markdown).toContain("Restart the pods.");
  });

  it("survives rich_text links whose URLs contain Slack control characters", async () => {
    allowReplies(slack, [
      {
        text: "plain reply",
        ts: "1700000000.123456",
        thread_ts: THREAD_TS,
        user: "U01",
      },
      {
        text: "",
        ts: "1700000000.123457",
        thread_ts: THREAD_TS,
        bot_id: "B01",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "link", url: "https://example.com/?q=a|b", text: "incident link" },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: undefined,
    });

    await thread.refresh();

    expect(thread.recentMessages).toHaveLength(2);
    expect(thread.recentMessages[0]?.markdown).toBe("plain reply");
    expect(thread.recentMessages[1]?.markdown).toContain("incident link");
    expect(thread.recentMessages[1]?.markdown).toContain("https://example.com/?q=a|b");
  });

  it("shares one conversations.replies request across overlapping refreshes", async () => {
    allowReplies(slack, [{ text: "loaded once", ts: "1.0", user: "U01" }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Holding the reply in flight is what makes the overlap
    // observable; the double behind the gate still serves it.
    const gatedFetch: typeof globalThis.fetch = async (target, init) => {
      if (String(target).endsWith("conversations.replies")) await gate;
      return slack.fetch(target, init);
    };
    const { thread } = buildSlackBinding({
      api: { fetch: gatedFetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const first = thread.refresh();
    const second = thread.refresh();

    expect(second).toBe(first);
    expect(slack.calls).toEqual([]);

    release();
    await Promise.all([first, second]);

    expect(slack.callsTo("conversations.replies")).toHaveLength(1);
    expect(thread.recentMessages).toHaveLength(1);
  });

  it("starts a new request after the previous refresh completes", async () => {
    allowReplies(slack, [
      { text: "root", ts: "1.0", user: "U01" },
      { text: "reply", ts: "1.1", thread_ts: "1.0", user: "U02" },
    ]);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.refresh();
    const firstSnapshot = thread.recentMessages;
    await thread.refresh();

    expect(slack.callsTo("conversations.replies")).toHaveLength(2);
    expect(thread.recentMessages).not.toBe(firstSnapshot);
    expect(firstSnapshot).toHaveLength(2);
  });

  it("preserves loaded messages when a later refresh fails", async () => {
    allowReplies(slack, [{ text: "root", ts: "1.0", user: "U01" }]);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });
    await thread.refresh();
    const loadedMessages = [...thread.recentMessages];
    slack.failNextHttp("conversations.replies", { status: 500 });

    await thread.refresh();

    expect(thread.recentMessages).toEqual(loadedMessages);
  });

  it("marks only replies from the bound Slack app as mine", async () => {
    allowReplies(slack, [
      {
        app_id: "A_SELF",
        bot_id: "B_SELF",
        text: "own user-attributed reply",
        thread_ts: "1.0",
        ts: "1.1",
        user: "U_SELF",
      },
      {
        app_id: "A_OTHER",
        bot_id: "B_OTHER",
        text: "other bot reply",
        thread_ts: "1.0",
        ts: "1.2",
        user: "U_OTHER",
      },
      {
        app_id: "A_SELF",
        bot_id: "B_SELF",
        text: "own app-attributed reply",
        thread_ts: "1.0",
        ts: "1.3",
      },
    ]);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      appId: "A_SELF",
      botToken: "xoxb-test",
      botUserId: "U_SELF",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.refresh();

    expect(thread.recentMessages.map((message) => message.isMe)).toEqual([true, false, true]);
  });
});

describe("SlackThread.listParticipants", () => {
  it("returns unique human user ids in first-appearance order", async () => {
    const slack = mockSlack();
    allowReplies(slack, [
      { text: "root", ts: "1.0", user: "U01" },
      {
        text: "bot reply",
        ts: "1.1",
        thread_ts: "1.0",
        user: "UAPP",
        bot_id: "B01",
      },
      { text: "second person", ts: "1.2", thread_ts: "1.0", user: "U02" },
      { text: "starter again", ts: "1.3", thread_ts: "1.0", user: "U01" },
      { text: "system message", ts: "1.4", thread_ts: "1.0" },
    ]);
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await expect(thread.listParticipants()).resolves.toEqual(["U01", "U02"]);

    expect(thread.recentMessages).toHaveLength(5);
    expect(slack.callsTo("conversations.replies")).toHaveLength(1);
  });
});

describe("SlackThread.postEphemeral", () => {
  it("posts via chat.postEphemeral with user / channel / thread_ts", async () => {
    const slack = mockSlack();
    slack.allow("chat.postEphemeral").andReturn({ ok: true, message_ts: "1700.1" });
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.postEphemeral("U99", { text: "psst" });

    const body = slack.bodyOf("chat.postEphemeral");
    expect(body.user).toBe("U99");
    expect(body.channel).toBe("C01");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toBe("psst");

    // Ephemerals go through chat.postEphemeral and never through the
    // ordinary post path, which is not stubbed here.
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });
});

describe("SlackThread.postDirectMessage", () => {
  it("opens the IM conversation and posts to it without a thread_ts", async () => {
    const slack = mockSlack();
    slack.allow("conversations.open").andReturn({ ok: true, channel: { id: "D99" } });
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "D99", ts: "1700.1" });
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    const posted = await thread.postDirectMessage("U99", { text: "for your eyes only" });

    expect(slack.bodyOf("conversations.open").users).toBe("U99");

    const imChannelId = "D99";
    const body = slack.bodyOf("chat.postMessage");
    expect(body.channel).toBe(imChannelId);
    expect(body.thread_ts).toBeUndefined();
    expect(body.text).toBe("for your eyes only");
    // The DM's id is the message ts Slack returned for the IM post.
    expect(posted.id).toBe("1700.1");
  });
});

describe("auto-anchor on first post", () => {
  let slack: MockSlack;

  /** The ts Slack assigns the first post, which becomes the thread root. */
  const ANCHOR_TS = "1700000000.000100";

  beforeEach(() => {
    slack = mockSlack();
    // Successive posts get distinct ts values, so an assertion cannot
    // pass by accident when production threads the wrong one.
    let next = 0;
    slack.allow("chat.postMessage").andRespond(() => ({
      ok: true,
      channel: "C01",
      ts: next++ === 0 ? ANCHOR_TS : `1700000000.00020${next}`,
    }));
  });

  it("first chat.postMessage on an unanchored binding adopts its own ts as the thread root", async () => {
    const anchors: string[] = [];
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    expect(binding.slack.threadTs).toBe("");

    const first = await binding.thread.post("first reply");

    expect(first.id).toBe(ANCHOR_TS);
    expect(anchors).toEqual([first.id]);
    expect(binding.slack.threadTs).toBe(first.id);

    // The first post itself lands at the channel root (no thread_ts in body)
    // because the anchor is set AFTER Slack assigns the ts.
    expect(slack.bodyOf("chat.postMessage").thread_ts).toBeUndefined();
  });

  it("subsequent posts thread under the anchored ts", async () => {
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    const first = await thread.post("first");
    await thread.post("second");
    await thread.post("third");

    expect(slack.callsTo("chat.postMessage")).toHaveLength(3);
    expect(slack.bodyOf("chat.postMessage", 0).thread_ts).toBeUndefined();
    expect(slack.bodyOf("chat.postMessage", 1).thread_ts).toBe(first.id);
    expect(slack.bodyOf("chat.postMessage", 2).thread_ts).toBe(first.id);
  });

  it("does not anchor when the binding already has a threadTs", async () => {
    const anchors: string[] = [];
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1700000000.000999",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await binding.thread.post("hello");

    expect(anchors).toEqual([]);
    expect(binding.slack.threadTs).toBe("1700000000.000999");
  });

  it("does not anchor on postEphemeral", async () => {
    slack.allow("chat.postEphemeral").andReturn({ ok: true, message_ts: "1700.9" });
    const anchors: string[] = [];
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await binding.thread.postEphemeral("U99", { text: "psst" });

    expect(anchors).toEqual([]);
    expect(binding.slack.threadTs).toBe("");
  });

  it("anchors before uploading files for a markdown post", async () => {
    allowUpload(slack);
    const anchors: string[] = [];
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    const posted = await binding.thread.post({
      markdown: "**Report attached**",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(anchors).toEqual([posted.id]);
    expect(binding.slack.threadTs).toBe(posted.id);

    expect(slack.bodyOf("chat.postMessage").thread_ts).toBeUndefined();

    // The upload hangs off the anchor the post just created.
    expect(slack.bodyOf("files.completeUploadExternal")).toMatchObject({ thread_ts: posted.id });
  });

  it("does not anchor on an upload-only text/file post", async () => {
    allowUpload(slack);
    const anchors: string[] = [];
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
      onThreadTsChanged(ts) {
        anchors.push(ts);
      },
    });

    await binding.thread.post({
      text: "*Report attached*",
      files: [{ data: Buffer.from([1]), filename: "report.csv", mimeType: "text/csv" }],
    });

    expect(anchors).toEqual([]);
    expect(binding.slack.threadTs).toBe("");
  });

  it("enables startTyping after a post anchors the thread", async () => {
    slack.allow("assistant.threads.setStatus").andReturn({ ok: true });
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "",
      teamId: undefined,
    });

    await thread.startTyping("Pre-anchor");
    expect(slack.callsTo("assistant.threads.setStatus")).toEqual([]);

    const anchor = await thread.post("anchor");
    await thread.startTyping("Post-anchor");

    // Before the anchor there is no thread to show a status in; after it,
    // the status targets the ts the post created.
    expect(slack.callsTo("assistant.threads.setStatus")).toHaveLength(1);
    expect(slack.bodyOf("assistant.threads.setStatus")).toMatchObject({
      channel_id: "C01",
      thread_ts: anchor.id,
      status: "Post-anchor",
      loading_messages: ["Post-anchor"],
    });
  });

  it("sends assistant status as plain text", async () => {
    slack.allow("assistant.threads.setStatus").andReturn({ ok: true });
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: "1.0",
      teamId: undefined,
    });

    await thread.startTyping("**Considering turbo tasks**");

    expect(slack.bodyOf("assistant.threads.setStatus")).toMatchObject({
      status: "Considering turbo tasks",
      loading_messages: ["Considering turbo tasks"],
    });
  });

  it("invokes onThreadTsChanged exactly once even on concurrent first-posts", async () => {
    const anchors: string[] = [];
    const { thread } = buildSlackBinding({
      api: { fetch: slack.fetch },
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

describe("Slack bot token context", () => {
  it("passes explicit identity to a context-aware token provider", async () => {
    const slack = mockSlack();
    slack.allow("auth.test").andReturn({ ok: true });
    const botToken = vi.fn((context: SlackBotTokenContext) => {
      expect(context).toEqual({ teamId: "T01" });
      return "xoxb-team-one";
    });

    await callSlackApi({
      botToken,
      context: { teamId: "T01" },
      operation: "auth.test",
      body: {},
      fetch: slack.fetch,
    });

    expect(botToken).toHaveBeenCalledTimes(1);
  });

  it("keeps zero-argument token providers supported", async () => {
    const botToken = vi.fn(() => "xoxb-legacy");

    const token = await resolveSlackBotToken(botToken, { teamId: "T01" });

    expect(token).toBe("xoxb-legacy");
    expect(botToken).toHaveBeenCalledTimes(1);
  });
});

describe("Slack Web API base URL", () => {
  const ORIGINAL_SLACK_API_URL = process.env.SLACK_API_URL;
  /** Workspace on Slack's own host, reached through the global `fetch`. */
  let slackHost: MockSlack;

  beforeEach(() => {
    delete process.env.SLACK_API_URL;
    slackHost = mockSlack();
    vi.stubGlobal("fetch", slackHost.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_SLACK_API_URL === undefined) delete process.env.SLACK_API_URL;
    else process.env.SLACK_API_URL = ORIGINAL_SLACK_API_URL;
  });

  it("defaults to Slack's own host", () => {
    expect(resolveSlackApiUrl()).toBe("https://slack.com/api/");
    expect(resolveSlackApiUrl({})).toBe("https://slack.com/api/");
  });

  it("normalizes a configured base to a trailing slash so the method is appended", async () => {
    expect(resolveSlackApiUrl({ url: "https://sim.example/api" })).toBe("https://sim.example/api/");
    const simulator = mockSlack({ url: "https://sim.example/api" });
    simulator.allow("chat.update").andReturn({ ok: true, ts: "1700.1" });

    for (const url of ["https://sim.example/api", "https://sim.example/api/"]) {
      await callSlackApiJson({
        api: { url, fetch: simulator.fetch },
        body: {},
        method: "chat.update",
        token: "xoxb",
      });
    }

    expect(simulator.calls.map((call) => call.url)).toEqual([
      "https://sim.example/api/chat.update",
      "https://sim.example/api/chat.update",
    ]);
  });

  it("encodes the JSON-only surfaces as JSON and signs them with the bot token", async () => {
    // Asserts the transport headers themselves, so it reads the raw
    // `init` instead of going through the double.
    const apiFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );

    const response = await callSlackApiJson({
      api: { url: "https://sim.example/api", fetch: apiFetch },
      body: { channel: "C01", ts: THREAD_TS, dropped: undefined },
      method: "chat.update",
      token: "xoxb-json",
    });

    expect(response).toEqual({ ok: true });
    expect(slackHost.calls).toEqual([]);
    const [url, init] = apiFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://sim.example/api/chat.update");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer xoxb-json",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C01", ts: THREAD_TS });
  });

  it("raises SlackApiError carrying the method and status on a non-2xx JSON call", async () => {
    const simulator = mockSlack({ url: "https://sim.example/api" });
    // Stubbed so the 500 is the only reason the call fails: without it
    // the double would reject views.open as undeclared, and the test
    // would pass on the wrong error.
    simulator.allow("views.open").andReturn({ ok: true, view: {} });
    simulator.failNextHttp("views.open", {
      status: 500,
      body: { ok: false, error: "expired_trigger_id" },
    });

    const rejection = callSlackApiJson({
      api: { url: "https://sim.example/api", fetch: simulator.fetch },
      body: { trigger_id: "T1", view: {} },
      method: "views.open",
      token: "xoxb-json",
    });

    await expect(rejection).rejects.toThrow(SlackApiError);
    await expect(rejection).rejects.toMatchObject({ method: "views.open", status: 500 });
  });

  it("normalizes the parsed pathname rather than the raw string", () => {
    expect(resolveSlackApiUrl({ url: "https://sim.example" })).toBe("https://sim.example/");
    expect(resolveSlackApiUrl({ url: "https://sim.example:8443/nested/api" })).toBe(
      "https://sim.example:8443/nested/api/",
    );
  });

  it("rejects a base URL carrying a query string or fragment", async () => {
    for (const url of ["https://sim.example/api?fixture=demo", "https://sim.example/api#frag"]) {
      expect(() => resolveSlackApiUrl({ url })).toThrow(/query string or fragment/);
      await expect(
        callSlackApiJson({ api: { url }, body: {}, method: "chat.update", token: "xoxb" }),
      ).rejects.toThrow(/query string or fragment/);
      const { thread } = buildSlackBinding({
        api: { url },
        botToken: "xoxb-test",
        channelId: "C01",
        threadTs: THREAD_TS,
        teamId: "T01",
      });
      await expect(thread.post({ text: "hi" })).rejects.toThrow(/query string or fragment/);
    }

    expect(slackHost.calls).toEqual([]);
  });

  it("rejects a relative base URL", () => {
    expect(() => resolveSlackApiUrl({ url: "sim.example/api" })).toThrow(/must be absolute/);
  });

  it("falls back to SLACK_API_URL when no url is configured", () => {
    process.env.SLACK_API_URL = "http://localhost:3000/api/slack";

    expect(resolveSlackApiUrl()).toBe("http://localhost:3000/api/slack/");
    expect(resolveSlackApiUrl({ url: "https://sim.example/api/" })).toBe(
      "https://sim.example/api/",
    );
  });

  it("rejects an invalid SLACK_API_URL the same way", () => {
    process.env.SLACK_API_URL = "https://env.example/api?fixture=demo";

    expect(() => resolveSlackApiUrl()).toThrow(/query string or fragment/);
  });

  it("keeps the default host for every binding call when nothing is configured", async () => {
    allowBindingCalls(slackHost);
    const binding = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: "T01",
    });

    await binding.thread.post({ text: "hi" });
    await binding.thread.startTyping("Thinking...");
    await binding.slack.request("auth.test", {});

    // The double answers only on its own base, so landing these calls at
    // all is itself the assertion that they went to Slack's host.
    expect(slackHost.calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/assistant.threads.setStatus",
      "https://slack.com/api/auth.test",
    ]);
  });

  it("routes every binding call through a configured api.url and api.fetch", async () => {
    const simulator = mockSlack({ url: "https://sim.example/api" });
    allowBindingCalls(simulator);
    allowReplies(simulator, [{ text: "root", ts: THREAD_TS, user: "U01" }]);
    const binding = buildSlackBinding({
      api: { url: "https://sim.example/api", fetch: simulator.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: "T01",
    });

    await binding.thread.post({ text: "hi" });
    await binding.thread.postEphemeral("U01", { text: "psst" });
    await binding.thread.startTyping("Thinking...");
    await binding.thread.refresh();
    await binding.slack.request("auth.test", {});

    expect(slackHost.calls).toEqual([]);
    expect(simulator.calls.map((call) => call.url)).toEqual([
      "https://sim.example/api/chat.postMessage",
      "https://sim.example/api/chat.postEphemeral",
      "https://sim.example/api/assistant.threads.setStatus",
      "https://sim.example/api/conversations.replies",
      "https://sim.example/api/auth.test",
    ]);
    // The refresh parsed the replies the simulator served. Slack would
    // also return the "hi" just posted; the double returns only what it
    // was told to.
    expect(binding.thread.recentMessages.map((message) => message.text)).toEqual(["root"]);
  });

  it("routes the whole upload handshake through a configured api.url and api.fetch", async () => {
    const simulator = mockSlack({ url: "https://sim.example/api" });
    allowUpload(simulator);
    const binding = buildSlackBinding({
      api: { url: "https://sim.example/api", fetch: simulator.fetch },
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: "T01",
    });

    const result = await binding.slack.uploadFiles([
      {
        data: new TextEncoder().encode("a,b\n1,2\n").buffer as ArrayBuffer,
        filename: "report.csv",
        mimeType: "text/csv",
      },
    ]);

    expect(result.fileIds).toEqual(["F1"]);
    expect(slackHost.calls).toEqual([]);
    expect(simulator.calls.map((call) => call.method)).toEqual([
      "files.getUploadURLExternal",
      "files.upload",
      "files.completeUploadExternal",
    ]);
    // Slack hands back an upload URL off the Web API path; it must still be
    // fetched with the configured fetch rather than the global one.
    expect(simulator.calls[1]!.url.startsWith("https://sim.example/files/upload/")).toBe(true);
  });

  it("routes binding calls through SLACK_API_URL with no explicit config", async () => {
    process.env.SLACK_API_URL = "https://env.example/api";
    const environment = mockSlack({ url: "https://env.example/api" });
    environment.allow("auth.test").andReturn({ ok: true });
    vi.stubGlobal("fetch", environment.fetch);
    const { slack } = buildSlackBinding({
      botToken: "xoxb-test",
      channelId: "C01",
      threadTs: THREAD_TS,
      teamId: "T01",
    });

    await slack.request("auth.test", {});

    expect(environment.calls.map((call) => call.url)).toEqual([
      "https://env.example/api/auth.test",
    ]);
  });

  it("accepts apiUrl and fetch on the exported callSlackApi", async () => {
    const simulator = mockSlack({ url: "https://sim.example/api" });
    simulator.allow("views.update").andReturn({ ok: true, view: {} });
    slackHost.allow("views.open").andReturn({ ok: true, view: {} });

    await callSlackApi({
      botToken: "xoxb-test",
      operation: "views.update",
      body: {},
      apiUrl: "https://sim.example/api",
      fetch: simulator.fetch,
    });
    await callSlackApi({ botToken: "xoxb-test", operation: "views.open", body: {} });

    expect(simulator.calls.map((call) => call.url)).toEqual([
      "https://sim.example/api/views.update",
    ]);
    expect(slackHost.calls.map((call) => call.url)).toEqual(["https://slack.com/api/views.open"]);
  });

  it("routes the workspace handle through the configured base", async () => {
    const simulator = mockSlack({ url: "https://sim.example/api/" });
    // Reached through the raw request escape hatch, which is outside
    // the typed contract.
    simulator.allowUncheckedMethod("usergroups.list", { ok: true, usergroups: [] });
    const handle = buildSlackWorkspaceHandle({
      api: { url: "https://sim.example/api/", fetch: simulator.fetch },
      botToken: "xoxb-test",
      teamId: "T01",
    });

    await handle.request("usergroups.list", {});

    expect(slackHost.calls).toEqual([]);
    expect(simulator.calls.map((call) => call.url)).toEqual([
      "https://sim.example/api/usergroups.list",
    ]);
  });
});
