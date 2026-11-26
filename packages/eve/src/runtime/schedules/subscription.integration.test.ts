import { createHmac } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { defineDynamic } from "#dynamic/definition.js";
import { installWorkflowHost } from "#execution/workflow-host/host.js";
import {
  scheduleCollectionTools,
  scheduleScopesTools,
} from "#context/schedule-collection-tools.js";
import { agentContentsOf } from "#definitions/compiled-agent.js";
import { z } from "#compiled/zod/index.js";
import {
  resolveApprovalPolicy,
  type ApprovalConfiguration,
  type ApprovalPolicy,
} from "#approval/definition.js";
import { loadContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { slackChannel } from "#public/channels/slack/index.js";
import { defineAgent } from "#public/definitions/agent.js";
import { byPrincipal, defineDynamicSchedules, schedules } from "#public/schedules/index.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { declared } from "#runtime/types.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/testing.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { loadCompiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { once } from "#tools/approval/policies.js";
import { evaluateApproval } from "#approval/evaluation.js";
import { serializeInputSchema } from "#tools/schema.js";
import type { ToolDefinition } from "#tools/definition.js";
import type { ScheduleOccurrenceEvent, ScheduleRecord } from "#public/schedules/subscription.js";

installWorkflowHost();

const alice = {
  attributes: {},
  authenticator: "fixture",
  principalId: "alice",
  principalType: "user",
};
async function bindCaller() {
  loadContext().set(AuthKey, alice);
  loadContext().set(
    SessionAgentKey,
    await loadCompiledSessionAgent({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  );
}

describe("schedule creation and invocation", () => {
  it("exposes direct operation schemas and approves prepared data without writing a changed destination", async () => {
    let destination = "C123";
    const provider = inMemoryScheduleProvider();
    const write = vi.spyOn(provider, "create");
    const updateWrite = vi.spyOn(provider, "update");
    const approvedTargets: string[] = [];
    const responseTargets: string[] = [];
    const dispatched = vi.fn();
    const subscription = defineDynamicSchedules({
      inputSchema: z.object({ task: z.string() }).strict(),
      provider,
      preparePayload(input) {
        return { task: input.task, target: destination };
      },
      approval: {
        create: {
          request: ({ payload }) => {
            approvedTargets.push(payload.target);
            return "user-approval";
          },
          response: ({ payload }) => {
            responseTargets.push(payload.target);
            return { status: "allowed" };
          },
        },
        update: {
          request: ({ payload }) => {
            approvedTargets.push(payload?.target ?? "timing-only");
            return "user-approval";
          },
          response: ({ payload }) => {
            responseTargets.push(payload?.target ?? "timing-only");
            return { status: "allowed" };
          },
        },
        invoke: once(),
      },
      auth: () => alice,
      run: dispatched,
    });
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/requests.ts",
          loadNamespace: async () => ({ default: subscription }),
        },
      ],
    });
    await app.runAsSession(undefined, async () => {
      await bindCaller();
      const tools = scheduleCollectionTools(subscription, "requests") as Record<
        string,
        ToolDefinition<never, unknown> & {
          execute(input: unknown, ctx: never): Promise<unknown>;
          label: { start(input: unknown): string };
        }
      >;
      expect(Object.keys(tools).sort()).toEqual(
        ["create", "delete", "disable", "enable", "get", "invoke", "list", "update"].map(
          (operation) => `schedule__requests__${operation}`,
        ),
      );
      const create = tools.schedule__requests__create!;
      const input = {
        name: "joke",
        expression: { type: "delay" as const, minutes: 1 },
        payload: { task: "A joke" },
      };
      expect(serializeInputSchema(create.inputSchema)).toMatchObject({
        type: "object",
        required: ["name", "expression", "payload"],
      });
      expect(tools.schedule__requests__list!.approval).toBeUndefined();
      const policyContext = (callId: string, toolInput: unknown) =>
        ({ callId, toolInput, toolName: "schedule__requests__create" }) as never;
      const request = resolveApprovalPolicy(create.approval!);
      await expect(
        request({
          callId: "steered",
          session: {
            auth: {
              current: alice,
              initiator: alice,
              steeredBy: [{ ...alice, principalId: "bob" }],
            },
          },
          toolInput: input,
          toolName: "schedule__requests__create",
        } as never),
      ).resolves.toMatchObject({
        type: "denied",
        reason: expect.stringContaining("dynamic schedules"),
      });
      expect(approvedTargets).toEqual([]);
      await expect(
        request(policyContext("invalid", { ...input, payload: {} })),
      ).resolves.toMatchObject({ type: "denied" });
      expect(approvedTargets).toEqual([]);
      await expect(request(policyContext("changed", input))).resolves.toBe("user-approval");
      expect(approvedTargets).toEqual(["C123"]);
      const response = (create.approval as ApprovalConfiguration).response!;
      await expect(response({ request: { callId: "changed" } } as never)).resolves.toEqual({
        status: "allowed",
      });
      expect(responseTargets).toEqual(["C123"]);
      destination = "C999";
      await expect(create.execute(input, { callId: "changed" } as never)).rejects.toThrow(
        "changed after approval",
      );
      expect(write).not.toHaveBeenCalled();
      await expect(request(policyContext("accepted", input))).resolves.toBe("user-approval");
      expect(create.label.start(input)).toBe("Create schedule: joke");
      const created = (await create.execute(input, {
        callId: "accepted",
      } as never)) as ScheduleRecord;
      expect(write.mock.calls[0]![1].payload).toMatchObject({
        envelope: { payload: { task: "A joke", target: "C999" } },
      });
      await expect(tools.schedule__requests__list!.execute({}, {} as never)).resolves.toMatchObject(
        { data: [{ name: created.name }] },
      );
      const update = tools.schedule__requests__update!;
      const updateInput = { name: created.name, payload: { task: "A new joke" } };
      const updateRequest = resolveApprovalPolicy(update.approval!);
      const updateResponse = (update.approval as ApprovalConfiguration).response!;
      await expect(
        updateRequest(policyContext("empty-update", { name: created.name })),
      ).resolves.toMatchObject({ type: "denied" });
      expect(updateWrite).not.toHaveBeenCalled();
      await expect(updateRequest(policyContext("update-changed", updateInput))).resolves.toBe(
        "user-approval",
      );
      await updateResponse({ request: { callId: "update-changed" } } as never);
      expect(responseTargets.at(-1)).toBe("C999");
      destination = "C456";
      await expect(
        update.execute(updateInput, { callId: "update-changed" } as never),
      ).rejects.toThrow("changed after approval");
      expect(updateWrite).not.toHaveBeenCalled();
      await expect(updateRequest(policyContext("update-accepted", updateInput))).resolves.toBe(
        "user-approval",
      );
      await update.execute(updateInput, { callId: "update-accepted" } as never);
      expect(updateWrite.mock.calls[0]![2].payload).toMatchObject({
        envelope: { payload: { task: "A new joke", target: "C456" } },
      });
      const timingInput = { name: created.name, expression: { type: "delay", minutes: 10 } };
      await expect(updateRequest(policyContext("timing", timingInput))).resolves.toBe(
        "user-approval",
      );
      expect(approvedTargets.at(-1)).toBe("timing-only");
      await updateResponse({ request: { callId: "timing" } } as never);
      expect(responseTargets.at(-1)).toBe("timing-only");
      await update.execute(timingInput, { callId: "timing" } as never);
      expect(updateWrite.mock.calls[1]![2].payload).toBeUndefined();
      const invoke = tools.schedule__requests__invoke!;
      const invoked = { name: created.name };
      const invokeContext = { toolName: "schedule__requests__invoke", toolInput: invoked } as never;
      const invokePolicy = resolveApprovalPolicy(invoke.approval!) as ApprovalPolicy;
      const asked = await evaluateApproval(invokePolicy, invokeContext);
      const memory = {
        pending: [],
        remembered: { [asked.remember!.key]: { interactionId: "approval-1", outcome: "accepted" } },
      } as const;
      expect(await evaluateApproval(invokePolicy, invokeContext, { memory })).toEqual({
        denied: false,
        clearedBy: { policy: "approval" },
      });
      expect(
        await evaluateApproval(
          resolveApprovalPolicy(tools.schedule__requests__delete!.approval!) as ApprovalPolicy,
          invokeContext,
          { memory },
        ),
      ).toEqual({ denied: false, awaitsPerson: true });
      await invoke.execute(invoked, {} as never);
      expect(dispatched).toHaveBeenCalledOnce();
      await tools.schedule__requests__delete!.execute(invoked, {} as never);
      await expect(
        tools.schedule__requests__get!.execute(invoked, {} as never),
      ).resolves.toBeNull();
    });
  });

  it("offers one set of tools for a definition's named scopes and keeps each scope's storage, payload, approvals, and run", async () => {
    const provider = inMemoryScheduleProvider();
    const created = vi.spyOn(provider, "create");
    const ran: string[] = [];
    const workflows = defineDynamicSchedules({
      description: "Schedule a task that runs unattended.",
      inputSchema: z.object({ task: z.string() }).strict(),
      provider,
      preparePayload: (input, context) => ({ task: input.task, target: context.scopeName }),
      scopes: {
        personal: byPrincipal,
        channel: {
          description: "Channel workflows.",
          id: "team-workflows",
          resolve: () => ["channel", "C1"],
          approval: {
            list: () => "user-approval",
            enable: { request: () => "user-approval" },
            delete: {
              request: () => "user-approval",
              response: () => ({ status: "allowed" }),
            },
            create: {
              request: () => "user-approval",
              response: ({ payload }) =>
                payload.target === "channel"
                  ? { status: "allowed" }
                  : { status: "rejected", reason: "wrong scope" },
            },
          },
          run: ({ payload }) => {
            ran.push(`channel run: ${payload.task}`);
          },
        },
      },
      approval: { invoke: once() },
      auth: () => alice,
      run: ({ payload }) => {
        ran.push(`shared run: ${payload.task}`);
      },
    });
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/workflows.ts",
          loadNamespace: async () => ({ default: workflows }),
        },
      ],
    });
    await app.runAsSession(undefined, async () => {
      await bindCaller();
      const bundle = requireCompiledBundle(loadContext());
      const slots = (await agentContentsOf(bundle)).files.scheduleTools.map(
        (definition) => definition.id,
      );
      expect(slots).toEqual(["tool::schedule__workflows"]);
      const resolved = declared(bundle.resolvedAgent, "schedules");
      expect(resolved.map((collection) => collection.name)).toEqual([
        "workflows/personal",
        "team-workflows",
      ]);

      const tools = scheduleScopesTools(
        resolved.map((collection) => ({
          collection: collection.name,
          definition: collection.definition,
          scope: collection.namedScope!.name,
          description: collection.namedScope!.description,
        })),
        "schedule__workflows",
      ) as Record<
        string,
        ToolDefinition<never, unknown> & { execute(input: unknown, ctx: never): Promise<unknown> }
      >;
      expect(Object.keys(tools).sort()).toEqual(
        ["create", "delete", "disable", "enable", "get", "invoke", "list", "update"].map(
          (operation) => `schedule__workflows__${operation}`,
        ),
      );
      const create = tools.schedule__workflows__create!;
      expect(serializeInputSchema(create.inputSchema)).toMatchObject({
        type: "object",
        required: ["scope", "name", "expression", "payload"],
        properties: {
          scope: {
            enum: ["personal", "channel"],
            description:
              'Which schedules the call acts on. "personal" "channel": Channel workflows.',
          },
        },
      });
      for (const tool of Object.values(tools)) {
        expect(tool.description).toMatch(/^Schedule a task that runs unattended\.\n\n/u);
        expect(tool.description).not.toContain("Channel workflows.");
      }

      const input = (scope: string) => ({
        scope,
        name: "digest",
        expression: { type: "delay" as const, minutes: 1 },
        payload: { task: `Send the ${scope} digest` },
      });
      const request = resolveApprovalPolicy(create.approval!);
      const policyContext = (callId: string, toolInput: unknown) =>
        ({ callId, toolInput, toolName: "schedule__workflows__create" }) as never;
      await expect(request(policyContext("unknown", input("team")))).resolves.toMatchObject({
        type: "denied",
        reason: expect.stringContaining("personal"),
      });
      const records: Record<string, ScheduleRecord> = {};
      for (const scope of ["personal", "channel"]) {
        await expect(request(policyContext(scope, input(scope)))).resolves.toBe("user-approval");
        records[scope] = (await create.execute(input(scope), {
          callId: scope,
        } as never)) as ScheduleRecord;
      }
      expect(
        created.mock.calls.map(([context, schedule]) => [
          context.collection,
          (schedule.payload as { envelope: { payload: { target: string } } }).envelope.payload
            .target,
        ]),
      ).toEqual([
        ["workflows/personal", "personal"],
        ["team-workflows", "channel"],
      ]);
      expect(new Set(created.mock.calls.map(([context]) => context.namespace)).size).toBe(2);

      const bob = { ...alice, principalId: "bob" };
      const answer = (
        toolInput: unknown,
        requester: typeof alice | null,
        responder: typeof alice,
        callId = "any",
      ) =>
        ({
          request: { callId, toolInput, principal: requester },
          response: { decision: "approve", principal: responder },
        }) as never;
      const requesterOnly = {
        status: "rejected",
        reason: "Only the person who requested this action can respond to this approval.",
      };
      const response = (create.approval as ApprovalConfiguration).response!;
      await expect(request(policyContext("gated", input("channel")))).resolves.toBe(
        "user-approval",
      );
      await expect(response(answer(input("channel"), alice, bob, "gated"))).resolves.toEqual({
        status: "allowed",
      });
      await expect(response(answer(input("personal"), alice, bob))).resolves.toEqual(requesterOnly);
      await expect(response(answer(input("personal"), alice, alice))).resolves.toEqual({
        status: "allowed",
      });
      await expect(response(answer(input("personal"), null, bob))).resolves.toEqual({
        status: "allowed",
      });
      const deleteResponse = (tools.schedule__workflows__delete!.approval as ApprovalConfiguration)
        .response!;
      const named = (scope: string) => ({ scope, name: records[scope]!.name });
      await expect(deleteResponse(answer(named("channel"), alice, bob))).resolves.toEqual({
        status: "allowed",
      });
      await expect(deleteResponse(answer(named("personal"), alice, bob))).resolves.toEqual(
        requesterOnly,
      );
      await expect(deleteResponse(answer(named("personal"), alice, alice))).resolves.toEqual({
        status: "allowed",
      });

      expect(
        (tools.schedule__workflows__enable!.approval as ApprovalConfiguration).response,
      ).toBeUndefined();

      const list = tools.schedule__workflows__list!;
      for (const scope of ["personal", "channel"])
        await expect(list.execute({ scope }, {} as never)).resolves.toMatchObject({
          data: [{ name: records[scope]!.name }],
        });
      const listPolicy = resolveApprovalPolicy(list.approval!) as ApprovalPolicy;
      const listContext = (scope: string) =>
        ({ toolName: "schedule__workflows__list", toolInput: { scope } }) as never;
      expect(await evaluateApproval(listPolicy, listContext("personal"))).toEqual({
        denied: false,
      });
      expect(await evaluateApproval(listPolicy, listContext("channel"))).toEqual({
        denied: false,
        awaitsPerson: true,
      });

      const invoke = tools.schedule__workflows__invoke!;
      const invokePolicy = resolveApprovalPolicy(invoke.approval!) as ApprovalPolicy;
      const invoked = (scope: string) => ({ scope, name: records[scope]!.name });
      const invokeContext = (scope: string) =>
        ({ toolName: "schedule__workflows__invoke", toolInput: invoked(scope) }) as never;
      const asked = await evaluateApproval(invokePolicy, invokeContext("personal"));
      const memory = {
        pending: [],
        remembered: { [asked.remember!.key]: { interactionId: "approval-1", outcome: "accepted" } },
      } as const;
      expect(await evaluateApproval(invokePolicy, invokeContext("personal"), { memory })).toEqual({
        denied: false,
        clearedBy: { policy: "approval" },
      });
      expect(
        await evaluateApproval(invokePolicy, invokeContext("channel"), { memory }),
      ).toMatchObject({ denied: false, awaitsPerson: true });

      await invoke.execute(invoked("personal"), {} as never);
      await invoke.execute(invoked("channel"), {} as never);
      expect(ran).toEqual([
        "shared run: Send the personal digest",
        "channel run: Send the channel digest",
      ]);

      await expect(loadScheduleCollectionDefinition(bundle, "team-workflows")).resolves.toBe(
        resolved[1]!.definition,
      );

      await expect(
        (await schedules(workflows, { scope: "channel" })).list(),
      ).resolves.toMatchObject({ data: [{ name: records.channel!.name }] });
      await expect(schedules(workflows)).rejects.toThrow(
        "pass one as { scope }: personal, channel",
      );
      await expect(schedules(workflows, { scope: "team" })).rejects.toThrow('no scope "team"');
      await expect(schedules(workflows, { scope: "toString" })).rejects.toThrow(
        'no scope "toString"',
      );
    });
  });

  it("prepares payload replacements as the updating caller while timing-only updates preserve the creator", async () => {
    let allowed = true;
    let preparations = 0;
    const operations: string[] = [];
    const messages: string[] = [];
    const outcomes: ScheduleOccurrenceEvent[] = [];
    const subscription = defineDynamicSchedules({
      inputSchema: z.object({ task: z.string() }).strict(),
      provider: inMemoryScheduleProvider(),
      tool: false,
      scope: () => "shared",
      async preparePayload(input, context) {
        preparations += 1;
        operations.push(context.operation);
        return { message: input.task, author: context.session.auth.current!.principalId };
      },
      auth: ({ principal, payload }) =>
        allowed && payload.author === principal.principalId
          ? { ...alice, principalId: principal.principalId }
          : null,
      run: ({ payload }) => {
        messages.push(payload.message);
      },
      events: {
        "occurrence.dispatched": (event) => {
          outcomes.push(event);
        },
      },
    });
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/prepared.ts",
          loadNamespace: async () => ({ default: subscription }),
        },
      ],
    });
    await app.runAsSession(undefined, async () => {
      await bindCaller();
      const client = await schedules(subscription);
      const created = await client.create({
        name: "prepared",
        expression: { type: "delay", minutes: 5 },
        payload: { task: "A joke" },
      });
      await client.get(created.name);
      await client.disable(created.name);
      await client.enable(created.name);
      await client.invoke(created.name);
      await client.invoke(created.name);
      expect(preparations).toBe(1);
      expect(messages).toEqual(["A joke", "A joke"]);
      expect(outcomes.map((event) => event.sessionIds)).toEqual([[], []]);
      expect(outcomes[0]!.occurrence).toMatchObject({
        name: created.name,
        displayName: "prepared",
      });
      expect(outcomes[0]!.executionId).not.toBe(outcomes[1]!.executionId);
      allowed = false;
      await expect(client.invoke(created.name)).rejects.toThrow("no longer authorized");
      expect(messages).toHaveLength(2);
      expect(outcomes).toHaveLength(2);
      allowed = true;
      loadContext().set(AuthKey, { ...alice, principalId: "bob" });
      const bobClient = await schedules(subscription);
      await bobClient.disable(created.name);
      const retimed = await bobClient.update(created.name, {
        expression: { type: "delay", minutes: 10 },
      });
      expect(retimed).toMatchObject({
        name: created.name,
        scheduleId: created.scheduleId,
        state: "inactive",
      });
      await bobClient.invoke(created.name);
      expect(preparations).toBe(1);
      expect(outcomes.at(-1)!.schedule!.principal.principalId).toBe("alice");
      await bobClient.update(created.name, {
        expression: { type: "delay", minutes: 15 },
        payload: { task: "Bob's reminder" },
      });
      await bobClient.invoke(created.name);
      expect(preparations).toBe(2);
      expect(operations).toEqual(["create", "update"]);
      expect(messages.at(-1)).toBe("Bob's reminder");
      expect(outcomes.at(-1)!.schedule).toMatchObject({
        principal: { principalId: "bob" },
        payload: { author: "bob", message: "Bob's reminder" },
        scope: "shared",
      });
    });
  });

  it("aliases a dynamic schedule's Slack post under the slack namespace so unmentioned thread replies continue the session", async () => {
    const signingSecret = "test-slack-secret";
    const rootTs = "1700000000.000100";
    const replyTs = "1700000000.000200";
    const prompts: string[] = [];
    const posted: Array<Record<string, unknown>> = [];
    const subscribedObservations: boolean[] = [];
    const dispatchedSessionIds: string[] = [];

    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          prompts.push(JSON.stringify(prompt));
          return textStreamResult(
            prompts.length === 1
              ? "What topics do we need to discuss during sync today?"
              : "Today is Thursday.",
          );
        },
        modelId: "scheduled-slack-thread-model",
        provider: "eve-test",
      }),
    );

    const slackFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = url.split("/").pop() ?? "";
      const body = decodeSlackApiBody(
        init?.body,
        new Headers(init?.headers).get("content-type"),
      ) as Record<string, unknown>;
      if (method === "chat.postMessage") {
        posted.push(body);
        const ts = posted.length === 1 ? rootTs : replyTs;
        return Response.json({ ok: true, ts, channel: body.channel ?? "C123" });
      }
      if (method === "conversations.info") {
        return Response.json({
          ok: true,
          channel: { id: "C123", is_channel: true, is_private: false },
        });
      }
      if (method === "conversations.replies") {
        return Response.json({ ok: true, messages: [] });
      }
      if (method === "chat.getPermalink") {
        return Response.json({
          ok: true,
          permalink: "https://example.slack.com/archives/C123/p1700000000000100",
        });
      }
      return Response.json({ ok: true });
    };

    const slack = slackChannel({
      api: { fetch: slackFetch },
      credentials: { botToken: "xoxb-test", signingSecret },
      async onMessage(ctx) {
        const subscribed = await ctx.isSubscribed();
        subscribedObservations.push(subscribed);
        return subscribed ? { auth: alice } : null;
      },
    });

    const workflows = defineDynamicSchedules({
      inputSchema: z.object({ channelId: z.string(), task: z.string() }).strict(),
      provider: inMemoryScheduleProvider(),
      tool: false,
      auth: () => alice,
      async run({ occurrence, payload, to }) {
        await to(slack, { channelId: payload.channelId }).send(payload.task, {
          idempotencyKey: `${occurrence.executionId}:run`,
        });
      },
      events: {
        "occurrence.dispatched"(event) {
          dispatchedSessionIds.push(...(event.sessionIds ?? []));
        },
      },
    });

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "scheduled-slack-follow",
      },
      modules: [
        {
          logicalPath: "channels/slack.ts",
          loadNamespace: async () => ({ default: slack }),
        },
        {
          logicalPath: "schedules/workflows.ts",
          loadNamespace: async () => ({ default: workflows }),
        },
      ],
    });

    await app.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const runtime = createTestInProcessRuntime({ compiledArtifactsSource });
      try {
        const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
        const payload = createScheduleCollectionPayload({
          application: "scheduled-slack-follow",
          collection: "workflows",
          envelope: {
            version: 3,
            payload: { channelId: "C123", task: "Ask the channel for sync topics." },
            scope: "channel:T01:C123",
            principal: {
              type: "user",
              authenticator: alice.authenticator,
              principalId: alice.principalId,
            },
          },
        });
        const occurrence = {
          collection: "workflows",
          executionId: "exec-sync-1",
          name: "sync-topics",
          scheduleId: "sch-sync-1",
          scheduledAt: "2026-11-26T15:00:00Z",
        };

        await dispatchScheduledOccurrence({
          bundle,
          collection: "workflows",
          definition: workflows,
          occurrence,
          payload,
          runtime,
        });

        expect(dispatchedSessionIds).toHaveLength(1);
        const scheduledSessionId = dispatchedSessionIds[0]!;
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toMatchObject({ channel: "C123" });
        expect(posted[0]?.thread_ts).toBeUndefined();

        const turnSettled = async (expectedCount: number) => {
          await vi.waitFor(async () => {
            const reader = (
              await runtime.getEventStream(scheduledSessionId, { follow: false })
            ).getReader();
            let settled = 0;
            for (let next = await reader.read(); !next.done; next = await reader.read()) {
              if (next.value.type === "turn.settled") settled += 1;
            }
            expect(settled).toBeGreaterThanOrEqual(expectedCount);
          });
        };
        await turnSettled(1);

        expect(await runtime.resolveContinuation(`slack:C123:${rootTs}`)).toEqual({
          sessionId: scheduledSessionId,
        });

        if (!isCompiledChannel(slack)) throw new Error("expected compiled slack channel");
        const postRoute = slack.routes.find(
          (route) => isHttpRouteDefinition(route) && route.method === "POST",
        );
        if (!postRoute || !isHttpRouteDefinition(postRoute)) {
          throw new Error("expected Slack POST route");
        }
        const rawBody = JSON.stringify({
          api_app_id: "A01",
          authorizations: [{ is_bot: true, user_id: "U_BOT" }],
          event: {
            channel: "C123",
            channel_type: "channel",
            text: "What's today?",
            thread_ts: rootTs,
            ts: "1700000000.000150",
            type: "message",
            user: "U_BARBA",
          },
          event_id: "EvFollowUp1",
          team_id: "T01",
          type: "event_callback",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = `v0=${createHmac("sha256", signingSecret)
          .update(`v0:${timestamp}:${rawBody}`)
          .digest("hex")}`;
        const webhook = new Request("https://agent.example.com/eve/v1/slack", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
          },
          body: rawBody,
        });
        const tasks: Promise<unknown>[] = [];
        const response = await postRoute.handler(webhook, {
          ...createChannelOperations({
            adapter: slack.adapter,
            channelName: "slack",
            runtime,
          }),
          waitUntil: (task: Promise<unknown>) => {
            tasks.push(task);
          },
        } as never);
        expect(response.status).toBe(200);
        await Promise.all(tasks);

        expect(subscribedObservations).toEqual([true]);
        await vi.waitFor(() => expect(posted).toHaveLength(2));
        await turnSettled(2);

        expect(posted[1]).toMatchObject({ channel: "C123", thread_ts: rootTs });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("What topics do we need to discuss during sync today?");
        expect(prompts[1]).toContain("What's today?");

        await dispatchScheduledOccurrence({
          bundle,
          collection: "workflows",
          definition: workflows,
          occurrence,
          payload,
          runtime,
        });
        expect(dispatchedSessionIds).toEqual([scheduledSessionId, scheduledSessionId]);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
