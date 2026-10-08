import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { resolveApprovalPolicy, type ApprovalConfiguration } from "#approval/definition.js";
import { loadContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { once } from "#tools/approval/policies.js";
import { serializeInputSchema } from "#tools/schema.js";
import { readDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
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
      const policyContext = (
        callId: string,
        toolInput: unknown,
        approvedTools = new Set<string>(),
      ) => ({ callId, toolInput, approvedTools, toolName: "schedule__requests__create" }) as never;
      const request = resolveApprovalPolicy(create.approval!);
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
      const callbacks = readDurableDynamicToolCallbacks(create)!;
      expect(callbacks.label!.start!.callback({}, input as never)).toBe("Create schedule: joke");
      const created = (await callbacks.execute!.callback(
        {},
        input as never,
        { callId: "accepted" } as never,
      )) as ScheduleRecord;
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
      await update.execute(timingInput, { callId: "timing" } as never);
      expect(updateWrite.mock.calls[1]![2].payload).toBeUndefined();
      const invoke = tools.schedule__requests__invoke!;
      const invoked = { name: created.name };
      const invokeContext = {
        toolName: "schedule__requests__invoke",
        toolInput: invoked,
        approvedTools: new Set(["schedule__requests__invoke"]),
      } as never;
      expect(await resolveApprovalPolicy(invoke.approval!)(invokeContext)).toBe("not-applicable");
      expect(
        await resolveApprovalPolicy(tools.schedule__requests__delete!.approval!)(invokeContext),
      ).toBe("user-approval");
      await invoke.execute(invoked, {} as never);
      expect(dispatched).toHaveBeenCalledOnce();
      await tools.schedule__requests__delete!.execute(invoked, {} as never);
      await expect(
        tools.schedule__requests__get!.execute(invoked, {} as never),
      ).resolves.toBeNull();
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
});
