import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  captureTurnEvents,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import {
  forkToSlackDmWorkflow,
  forkToTeamsThreadWorkflow,
  sendThenSleepWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import { defineChannel, POST } from "#public/channels/index.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { teamsChannel } from "#public/channels/teams/teamsChannel.js";
import { sessions } from "#public/server/index.js";
import { defineDynamic } from "#public/tools/index.js";
import { toInputSchema } from "#tools/schema.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("workflow tool channel handoffs", () => {
  it("deduplicates a retried send step at its address, and the body replay sends nothing", async () => {
    const deliveredTo: string[] = [];
    const { modelInputs, recordModelInputs } = modelInputRecorder();
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-channel-retry",
      execute: sendThenSleepWorkflow,
      modules: [
        recordModelInputs,
        {
          logicalPath: "channels/dm.ts",
          loadNamespace: async () => ({
            default: defineChannel({
              routes: [POST("/dm", async () => new Response("ok"))],
              async receive(input, { from }) {
                const session = await from(`dm:${String(input.target.userId)}`).send(
                  input.message,
                  { auth: input.auth },
                );
                deliveredTo.push(session.id);
                // The first delivery lands, but the step never records it.
                if (deliveredTo.length === 1) throw new Error("The delivery response was lost.");
                return session;
              },
            }),
          }),
        },
      ],
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-channel-retry",
          }),
        },
      ]);
      const reply = String(await readFirstTurnReply(run));
      const { sessionId } = JSON.parse(reply.slice(reply.indexOf("{"))) as { sessionId: string };
      // The retry reaches the same address; the replay after the sleep reuses the recorded
      // result and never calls receive() again.
      expect(deliveredTo).toEqual([sessionId, sessionId]);

      // The session reads its inbox in order, so by the turn that sees this marker it has
      // also seen any redelivered summary.
      await sendToSession(sessionId, "Marker.");
      await vi.waitFor(() => expect(lastModelInput(modelInputs, sessionId)).toContain("Marker."), {
        timeout: 15_000,
      });
      expect(
        userMessagesContaining(lastModelInput(modelInputs, sessionId), "Here is the summary."),
      ).toBe(1);
      await run.cancel();
    });
  }, 60_000);

  it("runs the fork-to-DM pattern against Slack, opening a new DM thread per fork", async () => {
    const signingSecret = "fork-pattern-signing-secret";
    const slackCalls: {
      readonly body: Record<string, string>;
      readonly method: string;
      readonly ts: string;
    }[] = [];
    let nextTs = 1;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "slack.com") return realFetch(input, init);
      const method = url.pathname.split("/").at(-1)!;
      const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
      slackCalls.push({
        body: Object.fromEntries(new URLSearchParams(String(init?.body))),
        method,
        ts,
      });
      if (method === "conversations.open") {
        return Response.json({ ok: true, channel: { id: "D_ALICE" } });
      }
      return Response.json({ ok: true, channel: "D_ALICE", message: { ts }, messages: [], ts });
    });
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const slack = slackChannel({ credentials: { botToken: "xoxb-test", signingSecret } });
    const { modelInputs, recordModelInputs } = modelInputRecorder();
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-slack-fork",
      execute: forkToSlackDmWorkflow,
      inputSchema: toInputSchema({ additionalProperties: false, properties: {}, type: "object" }),
      modules: [
        { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: slack }) },
        recordModelInputs,
      ],
      toolName: "fork_to_dm",
    });
    // The agent's first top-level post in the DM anchors the fork's thread.
    const threadRoots = () =>
      slackCalls
        .filter(
          ({ body, method }) =>
            body.channel === "D_ALICE" &&
            body.thread_ts === undefined &&
            method !== "conversations.open",
        )
        .map(({ ts }) => ts);

    await runtime.run(async () => {
      const source = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Run fork_to_dm" },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({ continuationToken: "http:slack-fork-source" }),
            "eve.auth": {
              attributes: { user_id: "U_ALICE" },
              authenticator: "slack-webhook",
              issuer: "slack:T01",
              principalId: "slack:T01:U_ALICE",
              principalType: "user",
            },
          },
        },
      ]);
      const sourceTurns = captureTurnEvents(source);
      try {
        const first = forkedSessionId(await sourceTurns.nextTurn());
        await waitForCompletedTurns(first, 1);
        const [firstThread] = threadRoots();
        expect(firstThread).toBeDefined();
        expect(lastModelInput(modelInputs, first)).toContain("Run fork_to_dm");

        // Slack has no thread to name for a DM target, so a second fork starts a second thread.
        await sendToSession(source.runId, "Run fork_to_dm");
        const second = forkedSessionId(await sourceTurns.nextTurn());
        expect(second).not.toBe(first);
        await waitForCompletedTurns(second, 1);

        // Alice replies in the first fork's thread; only that fork hears it.
        await deliverSlackDirectMessage(slack, signingSecret, {
          text: "Alice prefers Friday.",
          threadTs: firstThread!,
        });
        await waitForCompletedTurns(first, 2);
        expect(lastModelInput(modelInputs, first)).toContain("Alice prefers Friday.");
        expect(lastModelInput(modelInputs, second)).not.toContain("Alice prefers Friday.");
        expect(lastModelInput(modelInputs, source.runId)).not.toContain("Alice prefers Friday.");
      } finally {
        sourceTurns.dispose();
        await source.cancel();
      }
    });
  }, 90_000);

  it("runs the fork pattern against a Teams channel, starting a new thread per fork", async () => {
    const posts: { readonly body: string; readonly id: string; readonly url: string }[] = [];
    const teams = teamsChannel({
      api: {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const id = `ACTIVITY_${posts.length + 1}`;
          posts.push({ body: String(init?.body ?? ""), id, url: String(input) });
          return Response.json({ id });
        },
      },
      credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
    });
    const { modelInputs, recordModelInputs } = modelInputRecorder();
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-teams-fork",
      execute: forkToTeamsThreadWorkflow,
      inputSchema: toInputSchema({ additionalProperties: false, properties: {}, type: "object" }),
      modules: [
        { logicalPath: "channels/teams.ts", loadNamespace: async () => ({ default: teams }) },
        recordModelInputs,
      ],
      toolName: "fork_thread",
    });
    const channelConversation = "19:general@thread.tacv2";
    const threadRoots = () =>
      posts.filter(({ body }) => body.includes("Continuing this conversation in a new thread."));

    await runtime.run(async () => {
      const source = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Run fork_thread" },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({ continuationToken: "http:teams-fork-source" }),
            "eve.auth": {
              attributes: {
                conversation_id: `${channelConversation};messageid=SOURCE_ROOT`,
                scope: "channel",
                service_url: "https://smba.example.test/teams",
                tenant_id: "TENANT",
                user_id: "ALICE",
              },
              authenticator: "teams-activity",
              issuer: "teams:TENANT",
              principalId: "teams:TENANT:ALICE",
              principalType: "user",
            },
          },
        },
      ]);
      const sourceTurns = captureTurnEvents(source);
      try {
        const first = forkedSessionId(await sourceTurns.nextTurn());
        await waitForCompletedTurns(first, 1);
        expect(lastModelInput(modelInputs, first)).toContain("Run fork_thread");

        await sendToSession(source.runId, "Run fork_thread");
        const second = forkedSessionId(await sourceTurns.nextTurn());
        expect(second).not.toBe(first);
        await waitForCompletedTurns(second, 1);

        // Each fork posts its own root in the channel, outside the source thread.
        const roots = threadRoots();
        expect(roots.map(({ url }) => url)).toEqual([
          `https://smba.example.test/teams/v3/conversations/${encodeURIComponent(channelConversation)}/activities`,
          `https://smba.example.test/teams/v3/conversations/${encodeURIComponent(channelConversation)}/activities`,
        ]);

        // Alice replies in the first fork's thread; only that fork hears it.
        await deliverTeamsChannelReply(teams, {
          conversationId: `${channelConversation};messageid=${roots[0]!.id}`,
          text: "Alice prefers Friday.",
        });
        await waitForCompletedTurns(first, 2);
        expect(lastModelInput(modelInputs, first)).toContain("Alice prefers Friday.");
        expect(lastModelInput(modelInputs, second)).not.toContain("Alice prefers Friday.");
        expect(lastModelInput(modelInputs, source.runId)).not.toContain("Alice prefers Friday.");
      } finally {
        sourceTurns.dispose();
        await source.cancel();
      }
    });
  }, 90_000);
});

/** Records what each session's model sees at each step, through a public `step.started` resolver. */
function modelInputRecorder() {
  const modelInputs: { readonly sessionId: string; readonly text: string }[] = [];
  const recordModelInputs: ProgrammaticAgentModule = {
    logicalPath: "tools/record-model-input.ts",
    loadNamespace: async () => ({
      default: defineDynamic({
        events: {
          "step.started": (_event, ctx) => {
            modelInputs.push({ sessionId: ctx.session.id, text: JSON.stringify(ctx.messages) });
            return null;
          },
        },
      }),
    }),
  };
  return { modelInputs, recordModelInputs };
}

function userMessagesContaining(modelInput: string, text: string): number {
  const messages = JSON.parse(modelInput) as { readonly content: unknown; readonly role: string }[];
  return messages.filter(
    (message) => message.role === "user" && JSON.stringify(message.content).includes(text),
  ).length;
}

function lastModelInput(
  modelInputs: readonly { readonly sessionId: string; readonly text: string }[],
  sessionId: string,
): string {
  return modelInputs.filter((input) => input.sessionId === sessionId).at(-1)?.text ?? "";
}

async function sendToSession(sessionId: string, message: string): Promise<void> {
  await resumeSessionInbox(sessionCommandHookToken(sessionId), {
    delivery: {
      channelKind: "http",
      channelName: "test",
      deliveryId: `delivery-${message}-${Date.now()}`,
    },
    kind: "send",
    payload: { message },
  });
}

function forkedSessionId(turn: readonly { readonly type: string }[]): string {
  const reply = String(
    (
      filterEventsByType(turn as never, "message.completed").at(-1) as
        | { data: { message: string } }
        | undefined
    )?.data.message,
  );
  return (JSON.parse(reply.slice(reply.indexOf("{"))) as { sessionId: string }).sessionId;
}

async function waitForCompletedTurns(sessionId: string, count: number): Promise<void> {
  let completed = 0;
  for await (const event of sessions.attach(sessionId).stream()) {
    if (event.type === "turn.completed" && ++completed === count) return;
  }
}

/** Sends Alice's signed DM through the Slack channel's own events route. */
async function deliverSlackDirectMessage(
  slack: ReturnType<typeof slackChannel>,
  signingSecret: string,
  message: { readonly text: string; readonly threadTs: string },
): Promise<void> {
  const ts = "1700000999.000100";
  const body = JSON.stringify({
    event: {
      channel: "D_ALICE",
      channel_type: "im",
      event_ts: ts,
      text: message.text,
      thread_ts: message.threadTs,
      ts,
      type: "message",
      user: "U_ALICE",
    },
    event_id: "Ev_fork_reply",
    team_id: "T01",
    type: "event_callback",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  await postToChannelRoute(
    slack,
    "slack",
    new Request("https://agent.example.com/eve/v1/slack", {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
      method: "POST",
    }),
  );
}

/** Posts a channel message that mentions the bot, as Teams sends it for a reply in a thread. */
async function deliverTeamsChannelReply(
  teams: ReturnType<typeof teamsChannel>,
  message: { readonly conversationId: string; readonly text: string },
): Promise<void> {
  await postToChannelRoute(
    teams,
    "teams",
    new Request("https://agent.example.com/eve/v1/teams", {
      body: JSON.stringify({
        channelData: {
          channel: { id: "19:general@thread.tacv2" },
          team: { id: "TEAM" },
          tenant: { id: "TENANT" },
        },
        conversation: { conversationType: "channel", id: message.conversationId },
        entities: [
          { mentioned: { id: "BOT", name: "eve" }, text: "<at>eve</at>", type: "mention" },
        ],
        from: { id: "ALICE", name: "Alice" },
        id: "ALICE_REPLY",
        recipient: { id: "BOT", name: "eve" },
        serviceUrl: "https://smba.example.test/teams",
        text: `<at>eve</at> ${message.text}`,
        textFormat: "xml",
        type: "message",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
}

async function postToChannelRoute(
  channel: unknown,
  channelName: string,
  request: Request,
): Promise<void> {
  if (!isCompiledChannel(channel)) throw new Error(`Expected a compiled ${channelName} channel.`);
  const route = channel.routes.find((candidate) => candidate.method === "POST");
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error(`Expected the ${channelName} webhook route.`);
  }
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  const resolved = bundle.graph.root.channels.find((candidate) => candidate.name === channelName);
  if (resolved?.adapter === undefined)
    throw new Error(`Expected the resolved ${channelName} channel.`);
  const operations = createChannelOperations<unknown>({
    adapter: resolved.adapter,
    channelName,
    runtime: createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  });
  const pending: Promise<unknown>[] = [];
  await route.handler(request, {
    ...mockAgentRouteArgs(),
    ...operations,
    attachSession: vi.fn() as never,
    params: {},
    requestIp: null,
    to: vi.fn() as never,
    waitUntil: (task) => void pending.push(task),
  });
  await Promise.all(pending);
}
