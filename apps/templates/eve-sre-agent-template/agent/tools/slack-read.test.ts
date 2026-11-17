import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ToolContext } from "eve/tools";

const ACCESS_DENIED = /Slack conversation access denied/;
const operations: string[] = [];
let members: unknown = { members: ["U2"], ok: true };
let teamId = "T1";
let membershipPage = 0;

mock.module("@vercel/connect/eve", {
  namedExports: { connectSlackCredentials: () => ({ botToken: "test-token" }) },
});
mock.module("eve/channels/slack", {
  namedExports: {
    callSlackApi({
      operation,
      body,
    }: {
      operation: string;
      body: { channel?: string; cursor?: string };
    }) {
      operations.push(operation);
      if (operation === "auth.test") {
        return Promise.resolve({ ok: true, team_id: teamId });
      }
      if (operation === "conversations.members") {
        assert.equal(body.channel, "C123");
        membershipPage += 1;
        if (typeof members === "function") {
          return members(body.cursor);
        }
        return Promise.resolve(members);
      }
      return Promise.resolve({
        messages: [{ text: "private evidence", ts: "1712606400.000001" }],
        ok: true,
      });
    },
  },
});

const { default: history } = await import("./slack_read_channel_messages.ts");
const { default: thread } = await import("./slack_read_thread.ts");
const alice = {
  attributes: { team_id: "T1", user_id: "U1" },
  authenticator: "slack-webhook",
  issuer: "slack:T1",
  principalId: "slack:T1:U1",
  principalType: "user",
} as const;

for (const [name, tool] of [
  ["history", history],
  ["thread", thread],
] as const) {
  test(`${name} authorizes the caller and target before reading Slack evidence`, async () => {
    const execute = async (auth: unknown = alice) =>
      await tool.execute(
        {
          channelId: "<#C123|incident>",
          limit: 20,
          messageTs: "1712606400.000001",
        },
        { session: { auth: { current: auth } } } as ToolContext
      );
    const denied = async (auth: unknown = alice) => {
      operations.length = 0;
      await assert.rejects(execute(auth), ACCESS_DENIED);
      assert.ok(!operations.includes("conversations.history"));
      assert.ok(!operations.includes("conversations.replies"));
    };

    members = { members: ["U2"], ok: true };
    await denied();
    await denied(null);
    await denied({ ...alice, principalType: "service" });
    await denied({ ...alice, principalId: "slack:T1:U2" });
    teamId = "T2";
    await denied();
    assert.deepEqual(operations, ["auth.test"]);
    teamId = "T1";
    members = { error: "missing_scope", ok: false };
    await denied();
    members = { ok: true };
    await denied();
    members = () => Promise.reject(new Error("Slack unavailable"));
    await denied();

    members = (cursor: string | undefined) =>
      Promise.resolve(
        cursor
          ? { members: ["U1"], ok: true }
          : {
              members: ["U2"],
              ok: true,
              response_metadata: { next_cursor: "page-2" },
            }
      );
    const result = await execute();
    assert.ok("messageCount" in result);
    assert.equal(result.messageCount, 1);
    assert.equal(
      operations.at(-1),
      name === "history" ? "conversations.history" : "conversations.replies"
    );
    members = { members: ["U2"], ok: true };
    await denied(); // Revoking membership takes effect on the next read.

    membershipPage = 0;
    members = () =>
      Promise.resolve({
        members: [],
        ok: true,
        response_metadata: { next_cursor: `page-${membershipPage}` },
      });
    await denied();
    assert.equal(membershipPage, 20);
  });
}
