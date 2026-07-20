import { describe, expect, expectTypeOf, it } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { defineAgent } from "#public/definitions/agent.js";
import { none } from "#public/channels/auth.js";
import { eveChannel, defaultEveAuth } from "#public/channels/eve.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import {
  defineHook,
  type HookDefinition,
  type HookEventMap,
  type StreamEventHook,
} from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineInstrumentation } from "#public/definitions/instrumentation.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineSkill } from "#public/definitions/skill.js";
import { defineTool, experimental_workflow } from "#public/definitions/tool.js";

describe("definition helper exact inputs", () => {
  it("preserves literal inference for valid definitions", () => {
    const agent = defineAgent({
      description: "type-test",
      limits: {
        maxInputTokensPerSession: 200_000,
        maxOutputTokensPerSession: 20_000,
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
    expect(experimental_workflow({ maxSubagents: 6 }).maxSubagents).toBe(6);
    expect(schedule.cron).toBe("0 9 * * *");
  });

  it("keeps the public hook event map aligned with runtime stream events", () => {
    expectTypeOf<keyof HookEventMap>().toEqualTypeOf<HandleMessageStreamEvent["type"]>();
  });
});

function typeOnlyFixtures(): void {
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

  const instrumentationWithEnabled = {
    isEnabled: true,
    recordInputs: true,
  };
  // @ts-expect-error Instrumentation has no separate enable toggle.
  defineInstrumentation(instrumentationWithEnabled);

  defineInstrumentation({
    events: {
      "step.started"(input) {
        const sessionId: string = input.session.id;
        return { runtimeContext: { "test.session_id": sessionId } };
      },
    },
  });

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
      "session.failed"(_data, _channel) {
        // session.failed has no ctx — fires outside ALS on terminal failures.
        void _data;
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
        const continuationToken: string = channel.continuationToken;
        const sessionId: string = ctx.session.id;
        void continuationToken;
        void sessionId;
      },
      "session.failed"(_data, channel) {
        const continuationToken: string = channel.continuationToken;
        void continuationToken;
      },
    },
  });

  defineSandbox({
    async onSession({ ctx, use }) {
      const sessionId: string = ctx.session.id;
      const sandbox = await use();
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
