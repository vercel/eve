import { describe, expect, expectTypeOf, it } from "vitest";
import { z as z3 } from "zod/v3";

import { z } from "#compiled/zod/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineAgent, defineDynamic } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";
import { none } from "#public/channels/auth.js";
import { eveChannel, defaultEveAuth } from "#public/channels/eve.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import {
  defineHook,
  type HookDefinition,
  type HookEventMap,
  type StreamEventHook,
} from "#public/definitions/hook.js";
import {
  defineDynamic as defineDynamicInstructions,
  defineInstructions,
} from "#public/definitions/instructions.js";
import {
  defineInstrumentation,
  type ProviderDefinition,
} from "#public/definitions/instrumentation.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineSkill } from "#public/definitions/skill.js";
import {
  defineTool,
  type TaskExec,
  type TaskReceipt,
  type ToolDefinition,
} from "#public/tools/index.js";
import { experimental_workflow } from "#public/tools/workflow.js";

describe("definition helper exact inputs", () => {
  it("preserves literal inference for valid definitions", () => {
    const agent = defineAgent({
      description: "type-test",
      limits: {
        maxInputTokensPerSession: 200_000,
        maxOutputTokensPerSession: 20_000,
        maxTokenCostUsdPerSession: 1.5,
        sessionTimeoutMs: 86_400_000,
      },
      model: "anthropic/claude-sonnet-5",
    });

    const schedule = defineSchedule({
      cron: "0 9 * * *",
      markdown: "Send a digest.",
    });

    expect(agent.description).toBe("type-test");
    expect(agent.limits.maxInputTokensPerSession).toBe(200_000);
    expect(agent.limits.maxOutputTokensPerSession).toBe(20_000);
    expect(agent.limits.maxTokenCostUsdPerSession).toBe(1.5);
    expect(agent.limits.sessionTimeoutMs).toBe(86_400_000);
    expect(experimental_workflow({ maxSubagents: 6 }).maxSubagents).toBe(6);
    expect(schedule.cron).toBe("0 9 * * *");
  });

  it("accepts async-generator tool executors", () => {
    const streamedTool = defineTool({
      description: "Stream report progress.",
      inputSchema: { type: "object" },
      async *execute() {
        yield { phase: "collecting" };
        yield { phase: "complete" };
      },
    });

    expectTypeOf(streamedTool).toMatchTypeOf<
      ToolDefinition<Record<string, unknown>, { phase: string }>
    >();
    expectTypeOf<ReturnType<typeof streamedTool.execute>>().toEqualTypeOf<
      AsyncGenerator<{ phase: string }, void, unknown>
    >();
  });

  it("preserves ordinary async tool executor return types", () => {
    const ordinaryTool = defineTool({
      description: "React to a message.",
      inputSchema: z.object({ reaction: z.string() }),
      async execute(input) {
        return { ok: input.reaction.length > 0 };
      },
    });

    expectTypeOf<ReturnType<typeof ordinaryTool.execute>>().toEqualTypeOf<
      Promise<{ ok: boolean }>
    >();
  });

  it("types background tools in terms of the durable task capability", () => {
    const backgroundTool = defineTool({
      description: "Start a durable export.",
      execution: "background",
      inputSchema: z.object({ jobId: z.string() }),
      async *execute(input, _ctx, task) {
        expectTypeOf(task).toEqualTypeOf<TaskExec>();
        expectTypeOf(task.taskId).toEqualTypeOf<string>();
        expectTypeOf(task).not.toHaveProperty("delegated");
        yield { jobId: input.jobId };
        return { jobId: input.jobId };
      },
    });

    expectTypeOf(backgroundTool.execution).toEqualTypeOf<"background">();
    expectTypeOf<
      Parameters<NonNullable<typeof backgroundTool.toModelOutput>>[0]
    >().toEqualTypeOf<TaskReceipt>();
    expect(backgroundTool.execution).toBe("background");
  });

  it("infers tool input from Zod 3 schemas", () => {
    const tool = defineTool({
      description: "Fetch current weather for a city.",
      inputSchema: z3.object({ city: z3.string() }),
      execute(input) {
        expectTypeOf(input.city).toEqualTypeOf<string>();
        return input.city;
      },
    });

    expectTypeOf<ReturnType<typeof tool.execute>>().toEqualTypeOf<string>();
  });

  it("keeps the public hook event map aligned with runtime stream events", () => {
    expectTypeOf<keyof HookEventMap>().toEqualTypeOf<UnstampedMessageStreamEvent["type"]>();
  });
});

function typeOnlyFixtures(): void {
  defineDynamic({
    // @ts-expect-error defineDynamic is resolver-only.
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "session.started": () => "anthropic/claude-sonnet-5",
    },
  });

  defineAgent({
    // @ts-expect-error Dynamic model handlers must return a concrete selection.
    model: defineDynamic({
      events: {
        "session.started": () => null,
      },
    }),
  });

  // @ts-expect-error Dynamic model metadata belongs on each returned selection.
  defineAgent({
    model: defineDynamic({
      events: {
        "session.started": () => "anthropic/claude-sonnet-5",
      },
    }),
    modelContextWindowTokens: 200_000,
  });

  // @ts-expect-error Dynamic subagents require a parent-facing description.
  defineDynamic({
    events: {
      "session.started": () =>
        defineAgent({
          model: "anthropic/claude-sonnet-5",
        }),
    },
  });

  defineDynamic({
    build: { externalDependencies: ["just-bash"] },
    events: {
      "session.started": () =>
        Math.random() > 0.5
          ? defineAgent({
              description: "Delegate local research tasks.",
              model: "anthropic/claude-sonnet-5",
            })
          : defineRemoteAgent({
              description: "Delegate remote research tasks.",
              url: "https://research.example.com",
            }),
    },
  });

  defineDynamic({
    events: {
      "session.started": () =>
        defineAgent({
          description: "Delegate research tasks.",
          model: "anthropic/claude-sonnet-5",
        }),
    },
  });

  defineDynamic({
    events: {
      "session.started": () => ({
        review: defineRemoteAgent({
          description: "Delegate response review.",
          url: "https://review.example.com",
        }),
        triage: defineRemoteAgent({
          description: "Delegate request triage.",
          url: "https://triage.example.com",
        }),
      }),
    },
  });

  // @ts-expect-error A dynamic local-subagent selection must use a static model.
  defineDynamic({
    events: {
      "session.started": () =>
        defineAgent({
          description: "Delegate research tasks.",
          model: defineDynamic({
            events: {
              "session.started": () => "anthropic/claude-sonnet-5",
            },
          }),
        }),
    },
  });

  defineAgent({
    limits: {
      // @ts-expect-error Recursive delegation is root-only; this limit was removed.
      maxSubagentDepth: 4,
    },
    model: "anthropic/claude-sonnet-5",
  });

  defineAgent({
    limits: {
      // @ts-expect-error Workflow fan-out is configured by experimental_workflow.
      maxSubagents: 6,
    },
    model: "anthropic/claude-sonnet-5",
  });

  experimental_workflow({
    // @ts-expect-error Workflow maxSubagents must be a number.
    maxSubagents: "6",
  });

  const agentWithName = {
    model: "anthropic/claude-sonnet-5",
    name: "agent-name",
  };
  // @ts-expect-error Agent identity is path-derived.
  defineAgent(agentWithName);

  const hookWithName = {
    events: {},
    name: "audit",
  };
  // @ts-expect-error Hook identity is path-derived.
  defineHook(hookWithName);

  const instructionsWithName = {
    markdown: "Always be concise.",
    name: "system",
  };
  // @ts-expect-error Instructions identity is path-derived.
  defineInstructions(instructionsWithName);

  defineInstructions({ content: "Always be concise." });
  defineInstructions({ content: "Account context.", role: "user" });

  // @ts-expect-error Instructions use either content or deprecated markdown, never both.
  defineInstructions({
    content: "mixed",
    markdown: "mixed",
  });

  defineInstructions({
    content: "invalid role",
    // @ts-expect-error Instructions support only system and user roles.
    role: "assistant",
  });

  defineDynamicInstructions({
    events: {
      "session.started": () => defineInstructions({ content: "Session." }),
      "turn.started": async () => defineInstructions({ content: "Turn.", role: "user" }),
      // @ts-expect-error Dynamic instructions do not support step scope.
      "step.started": () => defineInstructions({ content: "Step." }),
    },
  });

  defineInstrumentation({
    isEnabled: true,
    recordInputs: true,
  });

  // Unlike the helpers above, `defineInstrumentation` takes a generic union — a
  // config and a provider overlap on `events` and `setup` — so it cannot use
  // `ExactDefinition`. Excess keys reach `eve build` instead.
  const instrumentationWithEnabled = {
    isEnabled: true,
    recordInputs: true,
  };
  defineInstrumentation(instrumentationWithEnabled);

  defineInstrumentation({
    events: {
      "step.started"(input) {
        const sessionId: string = input.session.id;
        return { runtimeContext: { "test.session_id": sessionId } };
      },
    },
  });

  const providerWithCapture: ProviderDefinition = { capture: "content" };
  void providerWithCapture;

  defineInstrumentation({
    // @ts-expect-error Instrumentation event hooks are authored through `events`.
    runtimeContext: {
      "step.started"() {
        return { runtimeContext: {} };
      },
    },
  });

  defineInstrumentation({
    // @ts-expect-error Instrumentation event hooks are authored through `events`.
    metadata: {
      "step.started"() {
        return { runtimeContext: { "test.session_id": "test-session" } };
      },
    },
  });

  const scheduleWithName = {
    cron: "0 9 * * *",
    markdown: "Send a digest.",
    name: "daily",
  };
  // @ts-expect-error Schedule identity is path-derived.
  defineSchedule(scheduleWithName);

  // @ts-expect-error Schedules must provide either markdown or run.
  defineSchedule({
    cron: "0 9 * * *",
  });

  // @ts-expect-error Schedules cannot provide both markdown and run.
  defineSchedule({
    cron: "0 9 * * *",
    markdown: "Send a digest.",
    run() {},
  });

  defineSchedule({
    cron: "0 9 * * *",
    markdown: "Send a digest.",
    // @ts-expect-error Schedules do not support approval policies.
    approval: () => "user-approval",
  });

  defineSchedule({
    cron: "0 9 * * *",
    markdown: "Send a digest.",
    // @ts-expect-error Schedules do not support tool approval policies.
    needsApproval: () => true,
  });

  const skillWithName = {
    description: "Use source docs.",
    markdown: "Prefer primary sources.",
    name: "research",
  };
  // @ts-expect-error Skill identity is path-derived.
  defineSkill(skillWithName);

  defineChannel({
    routes: [POST("/x", async () => new Response("ok"))],
    events: {
      "turn.started"(_data, _channel, ctx) {
        const sessionId: string = ctx.session.id;
        void sessionId;
      },
      "session.failed"(data, _channel) {
        // session.failed has no ctx — fires outside ALS on terminal failures.
        const sessionId: string = data.sessionId;
        void sessionId;
        void _channel;
      },
    },
  });

  const unknownStreamEventHook: StreamEventHook<unknown> = (event, ctx) => {
    const sessionId: string = ctx.session.id;
    const value: unknown = event;
    void sessionId;
    void value;
  };
  defineHook({
    events: {
      "*": unknownStreamEventHook,
    },
  });

  const actionResultHook = defineHook({
    events: {
      "action.result"(event) {
        const eventType: "action.result" = event.type;
        const result = event.data.result;
        void eventType;
        void result;
      },
    },
  });
  expectTypeOf(actionResultHook).toEqualTypeOf<HookDefinition<"action.result">>();

  defineHook({
    events: {
      // @ts-expect-error Hook subscribers must use a public hook event key.
      "internal.event"() {},
    },
  });

  eveChannel({
    auth: none(),
    onMessage(ctx, message) {
      const auth = defaultEveAuth(ctx);
      const request: Request = ctx.eve.request;
      const sessionId: string | undefined = ctx.eve.sessionId;
      const inboundMessage: unknown = message;
      void auth;
      void request;
      void sessionId;
      void inboundMessage;
      return { auth, context: ["typed onMessage context"] };
    },
    events: {
      "turn.started"(_data, channel, ctx) {
        const continuationToken: string | undefined = channel.continuation?.token;
        const sessionId: string = ctx.session.id;
        void continuationToken;
        void sessionId;
      },
      "session.failed"(data, channel) {
        const sessionId: string = data.sessionId;
        const continuationToken: string | undefined = channel.continuation?.token;
        void sessionId;
        void continuationToken;
      },
    },
  });

  eveChannel({
    auth: none(),
    // @ts-expect-error canonical eve HTTP messages must dispatch or fail.
    onMessage() {
      return null;
    },
  });

  defineSandbox({
    async onSession({ ctx, use }) {
      const sessionId: string = ctx.session.id;
      // @ts-expect-error Sandbox lifecycle access is unavailable during session initialization.
      void ctx.getSandbox;
      // @ts-expect-error Skill access is unavailable during session initialization.
      void ctx.getSkill;
      const sandbox = await use();
      // @ts-expect-error Runtime lifecycle access is unavailable during session initialization.
      void sandbox.delete;
      void sandbox;
      void sessionId;
    },
  });

  defineSandbox({
    async bootstrap({ use }) {
      const sandbox = await use();
      void sandbox;
    },
  });

  defineSandbox({
    revalidationKey: () => "bootstrap-v1",
    async bootstrap({ use }) {
      const sandbox = await use();
      void sandbox;
    },
  });

  // @ts-expect-error Sandbox revalidation keys are only valid with bootstrap.
  defineSandbox({
    revalidationKey: () => "unused",
  });

  defineTool({
    description: "Fetch current weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    execute(input) {
      const city: unknown = input.city;
      void city;
      // @ts-expect-error Raw JSON Schema is accepted but cannot infer property types.
      const typedCity: string = input.city;
      return { ok: true, typedCity };
    },
  });

  defineTool({
    description: "Removed top-level tool auth.",
    inputSchema: { type: "object" },
    // @ts-expect-error Tool auth providers must be passed inline to ctx.getToken(provider).
    auth: {
      async getToken() {
        return { token: "static" };
      },
    },
    execute() {
      return null;
    },
  });

  defineTool({
    description: "Removed tool approval key.",
    inputSchema: { type: "object" },
    // @ts-expect-error Authored tools use `approval`, not `needsApproval`.
    needsApproval: () => true,
    execute() {
      return null;
    },
  });
}

void typeOnlyFixtures;
