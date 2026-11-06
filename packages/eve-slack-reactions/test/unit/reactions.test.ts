import assert from "node:assert/strict";
import test from "node:test";

import {
  addEmojiReactions,
  removeEmojiReaction,
  resolveReactionTarget,
  type SlackReactionClient,
} from "../../extension/lib/reactions.ts";

test("reacts to a permalink in the current channel and rejects other channels", () => {
  assert.deepEqual(
    resolveReactionTarget({
      channelId: "C1",
      defaultTs: "1751401594.001200",
      messageUrl:
        "https://example.slack.com/archives/C1/p1751400000000100?thread_ts=1751300000.000100",
    }),
    { ok: true, ts: "1751400000.000100" },
  );
  assert.equal(
    resolveReactionTarget({
      channelId: "C1",
      messageUrl: "https://example.slack.com/archives/C2/p1751400000000100",
    }).ok,
    false,
  );
  assert.equal(resolveReactionTarget({ channelId: "C1", messageUrl: "https://x.test" }).ok, false);
});

test("an explicit message_ts must be a Slack ts that agrees with a permalink", () => {
  assert.deepEqual(resolveReactionTarget({ channelId: "C1", messageTs: "1751400000.000100" }), {
    ok: true,
    ts: "1751400000.000100",
  });
  assert.equal(resolveReactionTarget({ channelId: "C1", messageTs: "yesterday" }).ok, false);
  assert.equal(
    resolveReactionTarget({
      channelId: "C1",
      messageTs: "1751400000.000999",
      messageUrl: "https://example.slack.com/archives/C1/p1751400000000100",
    }).ok,
    false,
  );
});

test("without a locator, targets the default message or asks for one", () => {
  assert.deepEqual(resolveReactionTarget({ channelId: "C1", defaultTs: "1.0" }), {
    ok: true,
    ts: "1.0",
  });
  assert.equal(resolveReactionTarget({ channelId: "C1" }).ok, false);
});

function recordingClient(options: { reject?: ReadonlySet<string>; removeError?: string } = {}) {
  const added: string[] = [];
  const client: SlackReactionClient = {
    reactions: {
      async add({ name }) {
        if (options.reject?.has(name)) return { ok: false, error: "invalid_name" };
        added.push(name);
        return { ok: true };
      },
      async remove() {
        return options.removeError ? { ok: false, error: options.removeError } : { ok: true };
      },
    },
  };
  return { added, client };
}

test("a query uses the searched custom emoji, falling back to the standard one", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { added, client } = recordingClient({ reject: new Set(["broken_custom"]) });
  const result = await addEmojiReactions(
    client,
    "C1",
    "1.0",
    [
      { emoji: "tada", query: "shipped it" },
      { emoji: "fire", query: "impressive" },
      { emoji: "heart" },
    ],
    async (query) => (query === "shipped it" ? [{ name: "shipit" }] : [{ name: "broken_custom" }]),
  );
  assert.deepEqual(result, { reacted: ["shipit", "fire", "heart"], failed: 0 });
  assert.deepEqual(added, ["shipit", "fire", "heart"]);
});

test("without a search, reactions use their standard emoji and skip repeats", async () => {
  const { added, client } = recordingClient();
  const result = await addEmojiReactions(client, "C1", "1.0", [
    { emoji: "tada", query: "party" },
    { emoji: "tada" },
  ]);
  assert.deepEqual(result, { reacted: ["tada"], failed: 0 });
  assert.deepEqual(added, ["tada"]);
});

test("a duplicate reaction thrown by Slack counts as added", async () => {
  const client: SlackReactionClient = {
    reactions: {
      async add() {
        throw Object.assign(new Error("already_reacted"), { data: { error: "already_reacted" } });
      },
      async remove() {
        return { ok: true };
      },
    },
  };
  assert.deepEqual(await addEmojiReactions(client, "C1", "1.0", [{ emoji: "tada" }]), {
    reacted: ["tada"],
    failed: 0,
  });
});

test("removing an absent reaction reports false instead of failing", async () => {
  assert.equal(
    await removeEmojiReaction(
      recordingClient({ removeError: "no_reaction" }).client,
      "C1",
      "1.0",
      ":tada:",
    ),
    false,
  );
  assert.equal(await removeEmojiReaction(recordingClient().client, "C1", "1.0", "tada"), true);
});
