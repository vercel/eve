import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { resolveApprovalPolicy, type ApprovalConfiguration } from "#approval/definition.js";
import { once, always } from "#tools/approval/policies.js";
import { serializeInputSchema } from "#tools/schema.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
import { loadContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineScheduleSubscription } from "#public/schedules/subscription.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import type { ScheduleOccurrenceEvent, ScheduleRecord } from "#public/schedules/subscription.js";

const alice = {
  attributes: {},
  authenticator: "fixture",
  principalId: "alice",
  principalType: "user",
};

async function bindCaller() {
  loadContext().set(AuthKey, alice);
  loadContext().set(
    BundleKey,
    await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  );
}

describe("schedule subscription invocation", () => {
  it("routes management operations, validates input, and isolates approval policy by operation", async () => {
    const approval = vi.fn(() => "user-approval" as const);
    const dispatched = vi.fn();
    const response = vi.fn(() => ({
      status: "rejected" as const,
      reason: "Only the fixture administrator can delete.",
    }));
    const provider = inMemoryScheduleProvider();
    const write = vi.spyOn(provider, "create");
    const subscription = defineScheduleSubscription({
      schema: z.object({ task: z.string() }).strict(),
      provider,
      auth: () => alice,
      run: dispatched,
      tools: {
        approval: { create: approval, invoke: once(), delete: { request: always(), response } },
      },
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
      const wrapper = app.manifest.dynamicTools.find(
        (entry) => entry.logicalPath === "tools/schedule__requests.ts",
      )!;
      const dynamic = app.moduleMap.nodes.__root__!.modules[wrapper.sourceId]!
        .default as ReturnType<typeof import("#dynamic/definition.js").defineDynamic>;
      const tools = (await dynamic.events["turn.started"]!(undefined, {
        model: null,
        session: { id: "alice", auth: { current: alice, initiator: null } },
        channel: {},
        messages: [],
      })) as Record<string, DynamicToolEntry>;
      const manage = tools.schedule__requests__manage!;
      expect(Object.keys(tools)).toEqual(["schedule__requests__manage"]);
      expect(serializeInputSchema(manage.inputSchema)).toMatchObject({ type: "object" });
      const input = {
        operation: "create" as const,
        name: "joke",
        expression: { type: "delay" as const, minutes: 1 },
        payload: { task: "A joke" },
      };
      const policy = resolveApprovalPolicy(manage.approval!);
      const policyContext = (toolInput: unknown, approvedTools = new Set<string>()) =>
        ({ toolInput, approvedTools, toolName: "schedule__requests__manage" }) as never;
      await expect(policy(policyContext({ operation: "list" }))).resolves.toBe("not-applicable");
      await expect(policy(policyContext(input))).resolves.toBe("user-approval");
      expect(approval).toHaveBeenCalledOnce();
      await expect(manage.execute({ ...input, cursor: "irrelevant" }, {} as never)).rejects.toThrow(
        "not supported",
      );
      await expect(
        policy(policyContext({ operation: "create", name: "missing" })),
      ).resolves.toMatchObject({ type: "denied" });
      expect(write).not.toHaveBeenCalled();
      const created = (await manage.execute(input, {} as never)) as ScheduleRecord;
      await expect(manage.execute({ operation: "list" }, {} as never)).resolves.toMatchObject({
        data: [{ name: created.name }],
      });
      await expect(
        manage.execute({ operation: "get", name: created.name }, {} as never),
      ).resolves.toMatchObject({ displayName: "joke" });
      const invokeInput = { operation: "invoke", name: created.name };
      const invokeKey = manage.approvalKey!(invokeInput);
      const approved = new Set([invokeKey]);
      await expect(policy(policyContext(invokeInput))).resolves.toBe("user-approval");
      await expect(policy(policyContext(invokeInput, approved))).resolves.toBe("not-applicable");
      await expect(
        policy(policyContext({ operation: "disable", name: created.name }, approved)),
      ).resolves.toBe("user-approval");
      await expect(manage.execute(invokeInput, {} as never)).resolves.toEqual({ accepted: true });
      expect(dispatched).toHaveBeenCalledOnce();
      const approvalResponse = (manage.approval as ApprovalConfiguration).response!;
      const responder = {
        request: { principal: alice, toolInput: { operation: "delete", name: created.name } },
        response: { principal: alice },
      } as never;
      await expect(approvalResponse(responder)).resolves.toMatchObject({ status: "rejected" });
      expect(response).toHaveBeenCalledOnce();
      await expect(
        approvalResponse({
          request: { principal: alice, toolInput: invokeInput },
          response: { principal: { ...alice, principalId: "bob" } },
        } as never),
      ).resolves.toMatchObject({ status: "rejected" });
      const callbacks = readDurableDynamicToolCallbacks(manage)!;
      expect(
        await callbacks.approvalRequest!.callback({}, policyContext(invokeInput, approved)),
      ).toBe("not-applicable");
      expect(callbacks.approvalKey!.callback({}, invokeInput as never)).toBe(invokeKey);
      expect(callbacks.label!.start!.callback({}, invokeInput as never)).toBe("Run schedule: joke");
      await manage.execute({ operation: "delete", name: created.name }, {} as never);
      await expect(
        manage.execute({ operation: "get", name: created.name }, {} as never),
      ).resolves.toBeNull();
    });
  });

  it("dispatches prepared data unchanged, preserves occurrence identity, and revalidates the creator", async () => {
    let allowed = true;
    let preparations = 0;
    const messages: string[] = [];
    const outcomes: ScheduleOccurrenceEvent[] = [];
    const subscription = defineScheduleSubscription({
      schema: z.object({ task: z.string() }).strict(),
      provider: inMemoryScheduleProvider(),
      async prepare(input, context) {
        preparations += 1;
        return { message: input.task, author: context.session.auth.current!.principalId };
      },
      auth: ({ principal, payload }) =>
        allowed && payload.author === principal.principalId ? alice : null,
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
    });
  });
});
