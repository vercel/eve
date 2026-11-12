import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "../../src/client/index.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SIGNING_SECRET = "slack-reactions-secret";
const REACT_TOOL = "slack-reactions__react_with_emoji";

const DESCRIPTOR: ScenarioAppDescriptor = {
  name: "slack-reactions",
  installDependencies: true,
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel((request) => {
    if (request.toolResults.length > 0) return "Reacted.";
    if (!request.tools.some((tool) => tool.name === ${JSON.stringify(REACT_TOOL)})) {
      return "No reaction tool.";
    }
    return { toolCalls: [{ name: ${JSON.stringify(REACT_TOOL)}, input: { reactions: [{ emoji: "tada" }] } }] };
  }),
});
`,
    "agent/instructions.md": "React to good news.\n",
    "agent/channels/slack.ts": `import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  api: { apiBaseUrl: process.env.FAKE_SLACK_API_URL },
  credentials: { botToken: "xoxb-test", signingSecret: ${JSON.stringify(SIGNING_SECRET)} },
});
`,
    "agent/extensions/slack-reactions.ts": `import slackReactions from "eve/extensions/slack-reactions";

export default slackReactions({
  api: { apiBaseUrl: process.env.FAKE_SLACK_API_URL },
  credentials: { botToken: "xoxb-test" },
});
`,
  },
};

interface SlackCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A Slack Web API stand-in that records each call and answers every method with `ok`. */
async function fakeSlackApi(): Promise<{ url: string; calls: SlackCall[] }> {
  const calls: SlackCall[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//u, "");
      const body = request.headers["content-type"]?.includes("json")
        ? (JSON.parse(raw || "{}") as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, ts: "1700000002.000001", channel: "C1" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/`, calls };
}

function signedMention(url: string, ts: string): Request {
  const body = JSON.stringify({
    authorizations: [
      { is_bot: true, is_enterprise_install: false, team_id: "T1", user_id: "U_BOT" },
    ],
    event: {
      channel: "C1",
      channel_type: "channel",
      event_ts: ts,
      text: "<@U_BOT> we shipped it!",
      ts,
      type: "app_mention",
      user: "U_ALICE",
    },
    event_id: `Ev${ts}`,
    team_id: "T1",
    type: "event_callback",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request(new URL("/eve/v1/slack", url), {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    method: "POST",
  });
}

describe("slack-reactions extension", () => {
  it(
    "reacts to the mention that started a Slack turn and stays off other channels",
    async () => {
      const slack = await fakeSlackApi();
      const app = await scenarioApp(DESCRIPTOR);
      // The test-tier model adapter would replace the agent's own mock model.
      const server = await startEveDev(app.appRoot, {
        env: {
          EVE_MOCK_AUTHORED_MODELS: "",
          FAKE_SLACK_API_URL: slack.url,
          NODE_ENV: "development",
        },
      });
      try {
        const mentionTs = "1700000001.000100";
        const response = await fetch(signedMention(server.url, mentionTs));
        expect(response.status, server.stderr()).toBe(200);

        await waitForCondition(
          () => slack.calls.some((call) => call.method === "reactions.add"),
          () =>
            `No reactions.add call. Slack calls: ${JSON.stringify(slack.calls)}\n${server.stderr()}`,
        );
        expect(slack.calls.filter((call) => call.method === "reactions.add")).toEqual([
          { method: "reactions.add", body: { channel: "C1", name: "tada", timestamp: mentionTs } },
        ]);

        const { delivery } = await new Client({ baseUrl: server.url }).sessions.create({
          message: "We shipped it!",
        });
        await expect(delivery.result()).resolves.toMatchObject({ reply: "No reaction tool." });
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
