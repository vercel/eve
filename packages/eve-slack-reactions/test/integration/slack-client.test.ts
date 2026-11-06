import assert from "node:assert/strict";
import test from "node:test";

import { reactionClient } from "../../extension/lib/slack-client.ts";

test("reaction calls go to the configured host with the installation workspace token", async () => {
  const requests: { url: string; auth: string | null; body: string }[] = [];
  const tokenTeams: (string | undefined)[] = [];
  const client = reactionClient(
    {
      kind: "channel:slack",
      metadata: { channelId: "C1", teamId: "T1", installationTeamId: "T0" },
    },
    {
      credentials: {
        botToken: async ({ teamId }) => {
          tokenTeams.push(teamId);
          return "xoxb-test";
        },
      },
      api: {
        apiBaseUrl: "https://slack.example/api/",
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            auth: new Headers(init?.headers).get("authorization"),
            body: String(init?.body),
          });
          return Response.json({ ok: false, error: "already_reacted" });
        },
      },
    },
  );
  assert.deepEqual(await client.reactions.add({ channel: "C1", name: "tada", timestamp: "1.0" }), {
    ok: false,
    error: "already_reacted",
  });
  assert.deepEqual(tokenTeams, ["T0"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://slack.example/api/reactions.add");
  assert.equal(requests[0]?.auth, "Bearer xoxb-test");
  assert.match(requests[0]?.body ?? "", /name=tada/u);
});
