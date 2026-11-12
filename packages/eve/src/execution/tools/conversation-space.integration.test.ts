import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { defineTool } from "#public/tools/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import type { ToolContext } from "#tools/definition.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const signingSecret = "conversation-space-signing-secret";

describe("ctx.conversation in tools", () => {
  it.each([
    {
      // Slack's app_mention events carry no channel_type, so eve reads conversations.info.
      conversation: { id: "C_TEAM", is_channel: true, is_private: false },
      expected: {
        id: "slack:T01:C_TEAM",
        type: "shared",
        visibility: "public",
        workspaceId: "slack:T01",
      },
      event: { channel: "C_TEAM", type: "app_mention" },
      label: "a Slack channel mention",
    },
    {
      conversation: { id: "G_GROUP", is_mpim: true, is_private: true },
      expected: {
        id: "slack:T01:G_GROUP",
        type: "shared",
        visibility: "private",
        workspaceId: "slack:T01",
      },
      event: { channel: "G_GROUP", type: "app_mention" },
      label: "a Slack group DM mention",
    },
    {
      conversation: null,
      expected: {
        id: "slack:T01:D_ALICE",
        type: "direct",
        visibility: "private",
        workspaceId: "slack:T01",
      },
      event: { channel: "D_ALICE", channel_type: "im", type: "message" },
      label: "a Slack DM",
    },
  ] as const)(
    "reports the space of $label",
    async ({ conversation: info, event, expected }) => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== "slack.com") return realFetch(input, init);
        if (url.pathname.endsWith("/conversations.info")) {
          return Response.json(info ? { ok: true, channel: info } : { ok: false });
        }
        return Response.json({ ok: true, channel: event.channel, ts: "1700000001.000100" });
      });
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      const slack = slackChannel({ credentials: { botToken: "xoxb-test", signingSecret } });
      let reported: (conversation: ConversationContext | undefined) => void = () => {};
      const conversation = new Promise<ConversationContext | undefined>((resolve) => {
        reported = resolve;
      });
      const runtime = await createTestRuntime({
        agent: { name: `conversation-space-${event.channel}` },
        modules: [
          { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: slack }) },
          {
            logicalPath: "tools/read_space.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Reports where the conversation happens.",
                inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                execute: async (_input: unknown, ctx: ToolContext) => {
                  reported(ctx.conversation);
                  return { ok: true };
                },
              }),
            }),
          },
        ],
      });

      await runtime.run(async () => {
        await deliverSlackEvent(slack, {
          ...event,
          text: "<@U_BOT> Run read_space",
          ts: "1700000000.000100",
          user: "U_ALICE",
        });
        expect((await conversation)?.space).toEqual(expected);
      });
    },
    60_000,
  );
});

/** Sends a signed Slack event through the Slack channel's own events route. */
async function deliverSlackEvent(
  slack: ReturnType<typeof slackChannel>,
  event: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    authorizations: [{ is_bot: true, team_id: "T01", user_id: "U_BOT" }],
    event: { event_ts: event.ts, ...event },
    event_id: `Ev_${String(event.channel)}`,
    team_id: "T01",
    type: "event_callback",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  const resolved = bundle.graph.root.channels.find((candidate) => candidate.name === "slack");
  if (resolved?.adapter === undefined || !isCompiledChannel(slack)) {
    throw new Error("Expected the resolved Slack channel.");
  }
  const route = slack.routes.find((candidate) => candidate.method === "POST");
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error("Expected the Slack webhook route.");
  }
  const operations = createChannelOperations<unknown>({
    adapter: resolved.adapter,
    channelName: "slack",
    runtime: createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  });
  const pending: Promise<unknown>[] = [];
  await route.handler(
    new Request("https://agent.example.com/eve/v1/slack", {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      ...operations,
      attachSession: vi.fn() as never,
      params: {},
      requestIp: null,
      to: vi.fn() as never,
      waitUntil: (task) => void pending.push(task),
    },
  );
  await Promise.all(pending);
}
