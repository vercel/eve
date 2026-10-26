import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { captureTurnEvents, readFirstTurnReply } from "#internal/testing/events.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { sendThenSleepWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import { defineChannel, POST } from "#public/channels/index.js";
import { callSlackApi } from "#public/channels/slack/index.js";
import { type SlackChannel, slackChannel } from "#public/channels/slack/slackChannel.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { sessions } from "#public/server/index.js";
import { defineDynamic, defineTool } from "#public/tools/index.js";
import type { ToolContext } from "#tools/definition.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ctx.to() in tools", () => {
  it("deduplicates a workflow step's retried send at its address, and the body replay sends nothing", async () => {
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
              async receive({ message, target, ...send }, { from }) {
                const delivery = await from(`dm:${String(target.userId)}`).send(message, send);
                deliveredTo.push(delivery.sessionId);
                // The first delivery lands, but the step never records it.
                if (deliveredTo.length === 1) throw new Error("The delivery response was lost.");
                return delivery;
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
    const runtime = await createToolRuntime({
      agentName: "tool-slack-fork",
      execute: forkToSlackDm(slack),
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
});

/** A runtime whose agent has one ordinary tool, which the test model calls on "Run <toolName>". */
async function createToolRuntime(input: {
  readonly agentName: string;
  readonly execute: (input: Record<string, never>, ctx: ToolContext) => Promise<unknown>;
  readonly modules: readonly ProgrammaticAgentModule[];
  readonly toolName: string;
}) {
  return await createTestRuntime({
    agent: { name: input.agentName },
    modules: [
      ...input.modules,
      {
        logicalPath: `tools/${input.toolName}.ts`,
        loadNamespace: async () => ({
          default: defineTool({
            description: `Forks the conversation (${input.toolName}).`,
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            execute: input.execute,
          }),
        }),
      },
    ],
  });
}

/** Records what each session's model sees before each model call, through a dynamic value. */
function modelInputRecorder() {
  const modelInputs: { readonly sessionId: string; readonly text: string }[] = [];
  const recordModelInputs: ProgrammaticAgentModule = {
    logicalPath: "tools/record-model-input.ts",
    loadNamespace: async () => ({
      default: defineDynamic(async (ctx) => {
        modelInputs.push({ sessionId: ctx.session.id, text: JSON.stringify(await ctx.messages()) });
        return null;
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

function forkedSessionId(turn: readonly SessionStreamEvent[]): string {
  const reply = String(summarizeTurnEvents(turn).message);
  return (JSON.parse(reply.slice(reply.indexOf("{"))) as { sessionId: string }).sessionId;
}

async function waitForCompletedTurns(sessionId: string, count: number): Promise<void> {
  let completed = 0;
  for await (const event of sessions.attach(sessionId).stream()) {
    if (event.type === "turn.settled" && ++completed === count) return;
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

/** The conversation the model saw, as text history: what the pattern doc's tools copy. */
function toHistory(messages: ToolContext["messages"]): SessionHistoryMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return text === "" ? [] : [{ role: message.role, text }];
  });
}

/** The DM tool from docs/patterns/fork-conversations-into-new-threads.md, with test import paths. */
function forkToSlackDm(slack: SlackChannel) {
  return async (_input: Record<string, never>, ctx: ToolContext) => {
    const auth = ctx.session.auth.current;
    const userId = auth?.attributes.user_id;
    if (auth?.authenticator !== "slack-webhook" || typeof userId !== "string")
      return { forked: false, reason: "No Slack user to message." };

    const channelId = await openDirectMessage(userId);
    const history = toHistory(ctx.messages);
    const delivery = await ctx
      .to(slack, { channelId })
      // The test model reuses one call id per tool name, so the turn tells its forks apart.
      .send("Continue this conversation here.", {
        auth,
        history,
        idempotencyKey: `${ctx.session.turn.id}:${ctx.callId}`,
      });
    return { forked: true, sessionId: delivery.sessionId };
  };
}

async function openDirectMessage(userId: string) {
  const response = await callSlackApi({
    botToken: process.env.SLACK_BOT_TOKEN,
    operation: "conversations.open",
    body: { users: userId },
  });
  if (!response.ok) throw new Error(`conversations.open failed: ${String(response.error)}`);
  return (response.channel as { id: string }).id;
}
