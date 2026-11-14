import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitChannelWatchMessage,
  type ChannelWatchMessage,
  evaluateChannelWatchMessage,
} from "./admit.ts";

const message: ChannelWatchMessage = {
  author: { kind: "other" },
  channelId: "C1",
  teamId: "T1",
  ts: "1.0",
  visibleText: "Database latency is high",
};

test("returns each structural drop reason in policy order", () => {
  assert.deepEqual(
    evaluateChannelWatchMessage({
      ...message,
      subtype: "message_changed",
      threadTs: "0.9",
    }),
    { kind: "drop", reason: "thread_reply" }
  );
  assert.deepEqual(
    evaluateChannelWatchMessage({ ...message, subtype: "message_changed" }),
    {
      kind: "drop",
      reason: "ignored_subtype",
    }
  );
  assert.deepEqual(
    evaluateChannelWatchMessage({ ...message, author: { kind: "missing" } }),
    {
      kind: "drop",
      reason: "missing_author",
    }
  );
  assert.deepEqual(
    evaluateChannelWatchMessage({ ...message, author: { kind: "self" } }),
    {
      kind: "drop",
      reason: "bot_author",
    }
  );
  assert.deepEqual(
    evaluateChannelWatchMessage({ ...message, visibleText: "" }),
    {
      kind: "drop",
      reason: "empty_text",
    }
  );
});

test("thread replies do not read membership", async () => {
  let calls = 0;
  const result = await admitChannelWatchMessage(
    { ...message, threadTs: "0.9" },
    {
      has(): Promise<boolean> {
        calls += 1;
        return Promise.resolve(true);
      },
    }
  );

  assert.deepEqual(result, { kind: "drop", reason: "thread_reply" });
  assert.equal(calls, 0);
});

test("admit title is the first non-empty line of visible text", async () => {
  const result = await admitChannelWatchMessage(
    {
      ...message,
      visibleText: "\n\nP1: checkout is down\nmore context",
    },
    { has: async () => true }
  );

  assert.equal(result.kind, "admit");
  if (result.kind === "admit") {
    assert.equal(result.title, "P1: checkout is down");
  }
});

test("admits attachment-only Datadog bot messages when watched", async () => {
  const result = await admitChannelWatchMessage(
    {
      ...message,
      author: { isBot: true, kind: "other" },
      subtype: "bot_message",
      visibleText: "High error rate on checkout\np95 is above 2 seconds",
    },
    { has: async () => true }
  );

  assert.equal(result.kind, "admit");
  if (result.kind === "admit") {
    assert.equal(
      result.message.visibleText,
      "High error rate on checkout\np95 is above 2 seconds"
    );
    assert.equal(result.title, "High error rate on checkout");
  }
});

test("admits authorless workflow bot messages when watched", async () => {
  const result = await admitChannelWatchMessage(
    {
      ...message,
      author: { kind: "missing" },
      subtype: "bot_message",
      visibleText: "Workflow: deploy finished",
    },
    { has: async () => true }
  );

  assert.equal(result.kind, "admit");
  if (result.kind === "admit") {
    assert.equal(result.title, "Workflow: deploy finished");
  }
});

test("admits file shares when watched", async () => {
  const result = await admitChannelWatchMessage(
    { ...message, subtype: "file_share" },
    { has: async () => true }
  );
  assert.equal(result.kind, "admit");
});

test("admits messages from other bots when watched", async () => {
  const result = await admitChannelWatchMessage(
    { ...message, author: { isBot: true, kind: "other" } },
    { has: async () => true }
  );
  assert.equal(result.kind, "admit");
});

test("drops whitespace-only visible text", async () => {
  const result = await admitChannelWatchMessage(
    { ...message, visibleText: "   " },
    { has: async () => true }
  );
  assert.deepEqual(result, { kind: "drop", reason: "empty_text" });
});

test("drops eligible messages when the channel is not watched", async () => {
  const result = await admitChannelWatchMessage(message, {
    has: async () => false,
  });
  assert.deepEqual(result, { kind: "drop", reason: "not_watched" });
});

test("missing team or channel ids do not read membership", async () => {
  let calls = 0;
  const membership = {
    has(): Promise<boolean> {
      calls += 1;
      return Promise.resolve(true);
    },
  };

  assert.deepEqual(
    await admitChannelWatchMessage({ ...message, teamId: "" }, membership),
    {
      kind: "drop",
      reason: "not_watched",
    }
  );
  assert.deepEqual(
    await admitChannelWatchMessage({ ...message, channelId: "" }, membership),
    {
      kind: "drop",
      reason: "not_watched",
    }
  );
  assert.equal(calls, 0);
});
