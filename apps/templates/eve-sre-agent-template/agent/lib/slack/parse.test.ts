import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactSlackMessage,
  normalizeSlackChannelId,
  normalizeSlackTimestamp,
  normalizeSlackUserId,
} from "./parse.ts";

const CHANNEL_ID_ERROR = /Could not parse a Slack channel ID/u;
const TIMESTAMP_ERROR = /Could not parse a Slack message timestamp/u;
const USER_ID_ERROR = /Could not parse a Slack user ID/u;

describe("normalizeSlackChannelId", () => {
  it("accepts channel mentions, permalinks, and bare IDs", () => {
    assert.equal(
      normalizeSlackChannelId("<#C12345678|incidents>"),
      "C12345678"
    );
    assert.equal(
      normalizeSlackChannelId(
        "https://example.slack.com/archives/C87654321/p1770000000000000"
      ),
      "C87654321"
    );
    assert.equal(normalizeSlackChannelId(" c12345678 "), "C12345678");
  });

  it("rejects values that carry no channel ID", () => {
    assert.throws(
      () => normalizeSlackChannelId("not a channel"),
      CHANNEL_ID_ERROR
    );
  });
});

describe("normalizeSlackUserId", () => {
  it("accepts user mentions and bare IDs", () => {
    assert.equal(normalizeSlackUserId("<@U12345678|sre>"), "U12345678");
    assert.equal(normalizeSlackUserId("u12345678"), "U12345678");
  });

  it("rejects values that carry no user ID", () => {
    assert.throws(() => normalizeSlackUserId("someone"), USER_ID_ERROR);
  });
});

describe("normalizeSlackTimestamp", () => {
  it("accepts permalink timestamps and raw timestamps", () => {
    assert.equal(
      normalizeSlackTimestamp(
        "https://example.slack.com/archives/C12345678/p1770000000123456",
        "messageTs"
      ),
      "1770000000.123456"
    );
    assert.equal(
      normalizeSlackTimestamp("1770000000.123456", "messageTs"),
      "1770000000.123456"
    );
  });

  it("rejects unparseable values", () => {
    assert.throws(
      () => normalizeSlackTimestamp("yesterday", "messageTs"),
      TIMESTAMP_ERROR
    );
  });
});

describe("compactSlackMessage", () => {
  it("reads top-level text from raw Slack API messages", () => {
    const message = compactSlackMessage({
      bot_id: "B123",
      text: "checkout latency is high",
      ts: "1770000000.123456",
    });

    assert.equal(message?.text, "checkout latency is high");
    assert.equal(message?.botId, "B123");
  });

  it("does not read Block Kit-only messages", () => {
    const message = compactSlackMessage({
      blocks: [
        {
          text: { text: "*Deployment failed*", type: "mrkdwn" },
          type: "section",
        },
      ],
      bot_id: "B123",
      text: "",
      ts: "1770000000.123456",
    });

    assert.equal(message?.text, "");
    assert.equal(message?.botId, "B123");
  });

  it("drops entries without a message timestamp", () => {
    assert.equal(compactSlackMessage({ text: "hi" }), undefined);
  });
});
