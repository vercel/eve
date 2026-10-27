import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getRun } from "#internal/workflow/runtime.js";
import {
  captureTurnEvents,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import {
  sendFromStepWorkflow,
  sendThenSleepWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import { defineChannel, isChannel, POST } from "#public/channels/index.js";
import { callSlackApi, openCodeChannel } from "#public/channels/slack/index.js";
import { type SlackChannel, slackChannel } from "#public/channels/slack/slackChannel.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { sessions } from "#public/server/index.js";
import { defineDynamic, defineTool } from "#public/tools/index.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonObject } from "#shared/json.js";
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
          serializedContext: slackSourceContext("slack-fork-source", "U_ALICE"),
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

  it("opens a Slack code channel from a thread and continues the work there", async () => {
    const signingSecret = "code-channel-signing-secret";
    let createError: string | undefined;
    const slackCalls: { readonly body: Record<string, string>; readonly method: string }[] = [];
    let nextTs = 1;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "slack.com") return realFetch(input, init);
      const method = url.pathname.split("/").at(-1)!;
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      slackCalls.push({ body, method });
      if (method === "conversations.info") {
        return Response.json({
          ok: true,
          channel:
            body.channel === "C_CODE"
              ? { id: "C_CODE", properties: { record_channel: { record_type: "agent_channel" } } }
              : { id: body.channel, is_private: false },
        });
      }
      // Alice's message is a reply in the origin thread, which its permalink names.
      if (method === "chat.getPermalink") {
        return Response.json({
          ok: true,
          permalink: `https://acme.slack.com/archives/${body.channel}/p${body.message_ts!.replace(".", "")}?thread_ts=1700000000.000001&cid=${body.channel}`,
        });
      }
      // Slack returns the same channel for a repeated session_id.
      if (method === "agents.conversations.create") {
        return Response.json(
          createError === undefined
            ? { ok: true, channel_id: "C_CODE" }
            : { ok: false, error: createError },
        );
      }
      const ts = `1700000100.${String(nextTs++).padStart(6, "0")}`;
      return Response.json({ ok: true, channel: body.channel, message: { ts }, ts });
    });
    const slack = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret },
    });
    const { modelInputs, recordModelInputs } = modelInputRecorder();
    // The tool an app writes around openCodeChannel(), as docs/channels/slack.mdx shows.
    const runtime = await createToolRuntime<{ message: string; name: string }>({
      agentName: "tool-slack-code-channel",
      execute: async ({ message, name }, ctx) =>
        await openCodeChannel(ctx, slack, message, { name }),
      inputSchema: {
        additionalProperties: false,
        properties: { message: { type: "string" }, name: { type: "string" } },
        required: ["message", "name"],
        type: "object",
      },
      modules: [
        { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: slack }) },
        recordModelInputs,
      ],
      toolName: "open_code_channel",
    });
    const request =
      'Run open_code_channel with name "Fix the login test" and message "Start by reproducing it."';

    await runtime.run(async () => {
      const source = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: request },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({
              continuationToken: "slack:C_ORIGIN:1700000000.000001",
            }),
            // A thread session started by Alice's message, as the Slack channel records it.
            "eve.channel": {
              kind: "channel:slack",
              state: {
                channelId: "C_ORIGIN",
                installationTeamId: "T01",
                teamId: "T01",
                threadTs: "1700000000.000001",
                triggeringMessageTs: "1700000000.000002",
                triggeringUserId: "U_ALICE",
              },
            },
            // The message hook returned its own auth; the tool still finds the conversation.
            "eve.auth": {
              attributes: { email: "alice@example.com" },
              authenticator: "acme-sso",
              principalId: "acme:alice",
              principalType: "user",
            },
          },
        },
      ]);
      const sourceTurns = captureTurnEvents(source);
      try {
        const codeSession = forkedSessionId(await sourceTurns.nextTurn());
        await waitForCompletedTurns(codeSession, 1);
        // The code channel session starts from the thread and the tool's first message.
        expect(lastModelInput(modelInputs, codeSession)).toContain("Run open_code_channel");
        expect(lastModelInput(modelInputs, codeSession)).toContain("Start by reproducing it.");

        const create = slackCalls.find(({ method }) => method === "agents.conversations.create");
        expect(create?.body).toMatchObject({
          name: "Fix the login test",
          origin_channel_id: "C_ORIGIN",
          origin_message_ts: "1700000000.000002",
        });
        expect(create?.body.session_id).toMatch(/^[0-9a-f]{32}$/u);
        // The code channel's reply posts top-level.
        const codeReplies = slackCalls.filter(
          ({ body, method }) => method === "chat.postMessage" && body.channel === "C_CODE",
        );
        expect(codeReplies.length).toBeGreaterThan(0);
        expect(codeReplies.every(({ body }) => body.thread_ts === undefined)).toBe(true);

        // Alice writes in the code channel without a mention; only its session hears it.
        await deliverSlackChannelMessage(slack, signingSecret, {
          channel: "C_CODE",
          text: "Alice prefers Friday.",
        });
        await waitForCompletedTurns(codeSession, 2);
        expect(lastModelInput(modelInputs, codeSession)).toContain("Alice prefers Friday.");
        expect(lastModelInput(modelInputs, source.runId)).not.toContain("Alice prefers Friday.");
        // A reply in a thread inside the code channel reaches the same session and is
        // answered in that thread.
        const postsBefore = slackCalls.length;
        await deliverSlackChannelMessage(slack, signingSecret, {
          channel: "C_CODE",
          text: "Alice adds detail in a thread.",
          threadTs: "1700000100.000099",
        });
        await waitForCompletedTurns(codeSession, 3);
        expect(lastModelInput(modelInputs, codeSession)).toContain(
          "Alice adds detail in a thread.",
        );
        expect(
          slackCalls
            .slice(postsBefore)
            .filter(
              ({ body, method }) => method === "chat.postMessage" && body.channel === "C_CODE",
            )
            .map(({ body }) => body.thread_ts),
        ).toEqual(["1700000100.000099"]);

        // Another call for the same message reaches the same code channel and session.
        await sendToSession(source.runId, request);
        expect(forkedSessionId(await sourceTurns.nextTurn())).toBe(codeSession);

        // A permanent Slack refusal fails the call with Slack's error for the model to relay.
        createError = "feature_disabled";
        await sendToSession(source.runId, request);
        const settled = filterEventsByType(await sourceTurns.nextTurn(), "call.settled");
        expect(settled.map(({ data }) => data.error?.message ?? data.output)).toContain(
          "Slack agents.conversations.create failed: feature_disabled",
        );
      } finally {
        sourceTurns.dispose();
        await source.cancel();
      }
    });
  }, 90_000);

  it("gives two sessions whose fork calls share a call id separate forks in one Slack channel", async () => {
    let nextTs = 1;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "slack.com") return realFetch(input, init);
      const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
      return Response.json({ ok: true, channel: "C_TEAM", message: { ts }, messages: [], ts });
    });
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const slack = slackChannel({ credentials: { botToken: "xoxb-test", signingSecret: "s" } });
    const runtime = await createToolRuntime({
      agentName: "tool-slack-fork-thread",
      execute: forkToSlackThread(slack),
      modules: [
        { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: slack }) },
      ],
      toolName: "fork_thread",
    });

    await runtime.run(async () => {
      // Alice and Bob each ask to fork their own thread; the test model gives both calls one id.
      const sources = await Promise.all(
        ["U_ALICE", "U_BOB"].map((userId) =>
          startSessionOwner(workflowEntry, [
            {
              kind: "initial",
              ownerDeploymentId: "dpl_inline",
              input: { message: "Run fork_thread" },
              serializedContext: slackSourceContext(`slack-thread-${userId}`, userId),
            },
          ]),
        ),
      );
      try {
        const forks = await Promise.all(
          sources.map(async (source) => {
            const turns = captureTurnEvents(source);
            try {
              return forkedSessionId(await turns.nextTurn());
            } finally {
              turns.dispose();
            }
          }),
        );
        expect(forks[0]).not.toBe(forks[1]);
        await Promise.all(forks.map((fork) => getRun(fork).cancel()));
      } finally {
        await Promise.all(sources.map((source) => source.cancel()));
      }
    });
  }, 90_000);

  it.each(["ordinary", "workflow"] as const)(
    "refuses ctx.to() in a %s tool that a root copy calls",
    async (kind) => {
      const dm = defineChannel({ routes: [POST("/dm", async () => new Response("ok"))] });
      const modules: ProgrammaticAgentModule[] = [
        { logicalPath: "channels/dm.ts", loadNamespace: async () => ({ default: dm }) },
      ];
      const runtime =
        kind === "ordinary"
          ? await createToolRuntime({
              agentName: "delegated-ordinary-to",
              execute: async (_input, ctx) => {
                try {
                  ctx.to(dm, { userId: "alice" });
                  return { refused: null };
                } catch (error) {
                  return { refused: (error as Error).message };
                }
              },
              modules,
              toolName: "send_note",
            })
          : await createWorkflowToolRuntime({
              agentName: "delegated-workflow-to",
              execute: sendFromStepWorkflow,
              modules,
              toolName: "send_note",
            });

      await runtime.run(async () => {
        const run = await startSessionOwner(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "Delegate to a subagent: Run send_note" },
            serializedContext: buildWorkflowToolSerializedContext({
              continuationToken: `http:delegated-${kind}-to`,
            }),
          },
        ]);
        expect(String(await readFirstTurnReply(run))).toContain(
          "ctx.to() isn't available in a delegated session",
        );
      });
    },
    60_000,
  );
});

/** A source session in a Slack thread, started by the given user, as Slack's webhook starts one. */
function slackSourceContext(name: string, userId: string): Record<string, unknown> {
  return {
    ...buildWorkflowToolSerializedContext({ continuationToken: `http:${name}` }),
    "eve.auth": {
      attributes: { user_id: userId },
      authenticator: "slack-webhook",
      issuer: "slack:T01",
      principalId: `slack:T01:${userId}`,
      principalType: "user",
    },
    "eve.channelInstrumentation": {
      kind: "channel:slack",
      metadata: {
        channelId: "C_TEAM",
        teamId: "T01",
        threadTs: `1699999999.${userId}`,
        triggeringUserId: userId,
      },
    },
  };
}

/** A runtime whose agent has one ordinary tool, which the test model calls on "Run <toolName>". */
async function createToolRuntime<TInput = Record<string, never>>(input: {
  readonly agentName: string;
  readonly execute: (input: TInput, ctx: ToolContext) => Promise<unknown>;
  readonly inputSchema?: JsonObject;
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
            inputSchema: input.inputSchema ?? {
              additionalProperties: false,
              properties: {},
              type: "object",
            },
            execute: input.execute as (input: unknown, ctx: ToolContext) => Promise<unknown>,
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
    if (!isChannel(ctx.channel, slack) || typeof userId !== "string")
      return { forked: false, reason: "No Slack user to message." };

    const channelId = await openDirectMessage(userId);
    const history = toHistory(ctx.messages);
    const delivery = await ctx.to(slack, { channelId }).send("Continue this conversation here.", {
      auth,
      history,
      idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
    });
    return { forked: true, sessionId: delivery.sessionId };
  };
}

/** The thread tool from docs/patterns/fork-conversations-into-new-threads.md. */
function forkToSlackThread(slack: SlackChannel) {
  return async (_input: Record<string, never>, ctx: ToolContext) => {
    if (!isChannel(ctx.channel, slack) || ctx.channel.metadata.channelId === null)
      return { forked: false, reason: "This conversation is not in Slack." };
    const { channelId } = ctx.channel.metadata;
    const auth = ctx.session.auth.current;

    const history = toHistory(ctx.messages);
    const delivery = await ctx.to(slack, { channelId }).send("Continue this conversation here.", {
      auth,
      history,
      idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
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

/** Sends Alice's signed, un-mentioned channel message through the Slack events route. */
async function deliverSlackChannelMessage(
  slack: ReturnType<typeof slackChannel>,
  signingSecret: string,
  message: { readonly channel: string; readonly text: string; readonly threadTs?: string },
): Promise<void> {
  const ts = message.threadTs === undefined ? "1700000999.000200" : "1700000999.000300";
  const body = JSON.stringify({
    authorizations: [{ is_bot: true, team_id: "T01", user_id: "U_EVE" }],
    event: {
      channel: message.channel,
      channel_type: "channel",
      event_ts: ts,
      text: message.text,
      ...(message.threadTs !== undefined && { thread_ts: message.threadTs }),
      ts,
      type: "message",
      user: "U_ALICE",
    },
    event_id: `Ev_code_channel_message_${ts}`,
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
