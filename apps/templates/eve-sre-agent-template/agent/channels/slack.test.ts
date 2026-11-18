import assert from "node:assert/strict";
import { mock, test } from "node:test";

const ANSWER = /Answer/u;
const EVIDENCE = /Metrics/u;
const ANSWER_OR_EVIDENCE = /Answer|Metrics/u;
const DELIVERY_NOTICE = /couldn't deliver/iu;

mock.module("@vercel/connect/eve", {
  namedExports: { connectSlackCredentials: () => ({ botToken: "test-token" }) },
});
const evidence = await import("../lib/evidence.ts");
mock.module("#lib/evidence.ts", {
  namedExports: {
    ...evidence,
    getInvestigationEvidence: () => [
      {
        finding: "Error rate increased.",
        id: "evidence-1",
        sourceLabel: "Metrics",
        sourceType: "other",
        sourceUrl: "https://example.com/metrics",
      },
    ],
  },
});

// Keep Slack's real renderer chain and delivery wrapper; bypass only eve's
// ambient callback-context binding so the boundary can run in memory.
const channelDefinitionUrl = new URL(
  "../../definitions/channel.js",
  import.meta.resolve("eve/channels/slack")
);
const channelDefinition = await import(channelDefinitionUrl.href);
mock.module(channelDefinitionUrl, {
  namedExports: {
    ...channelDefinition,
    defineChannel: (definition: object) => ({
      ...definition,
      __kind: "eve:channel",
    }),
  },
});
const { default: slack } = await import("./slack.ts");
assert.ok("events" in slack);
const adapter = slack.events as Record<
  string,
  (event: unknown, ctx: unknown) => Promise<void>
>;

test("rejected investigation posts reach eve's delivery notice without resending the answer", async () => {
  const posts: unknown[] = [];
  const state: { undeliveredReplyErrorId?: string } = {};
  const handler = adapter["content.completed"];
  assert.ok(handler);
  await handler(
    {
      data: { kind: "text", partId: "part-1", phase: "reply", value: "Answer" },
      scope: { turnId: "turn-1" },
      type: "content.completed",
    } as Parameters<typeof handler>[0],
    {
      channel: {
        state,
        thread: {
          post(message: unknown) {
            posts.push(message);
            return posts.length === 1
              ? Promise.reject(new Error("invalid_blocks"))
              : Promise.resolve({ id: "notice" });
          },
        },
      },
      session: { turn: { id: "turn-1" } },
    } as Parameters<typeof handler>[1]
  );
  assert.equal(posts.length, 2);
  assert.match(JSON.stringify(posts[0]), ANSWER);
  assert.doesNotMatch(JSON.stringify(posts[1]), ANSWER_OR_EVIDENCE);
  assert.match(JSON.stringify(posts[1]), DELIVERY_NOTICE);
  assert.ok(state.undeliveredReplyErrorId);
  assert.ok(String(posts[1]).includes(state.undeliveredReplyErrorId));
});

test("a delivered investigation answer is posted only once", async () => {
  const posts: unknown[] = [];
  const handler = adapter["content.completed"];
  assert.ok(handler);
  await handler(
    {
      data: { kind: "text", partId: "part-2", phase: "reply", value: "Answer" },
      scope: { turnId: "turn-2" },
      type: "content.completed",
    } as Parameters<typeof handler>[0],
    {
      channel: {
        state: {},
        thread: {
          post(message: unknown) {
            posts.push(message);
            return Promise.resolve({ id: "reply" });
          },
        },
      },
      session: { turn: { id: "turn-2" } },
    } as Parameters<typeof handler>[1]
  );
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0]), ANSWER);
  assert.match(JSON.stringify(posts[0]), EVIDENCE);
});
