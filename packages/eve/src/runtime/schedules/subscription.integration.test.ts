// @linux-only: schedule operation schemas
import { describe, expect, it, vi } from "vitest";
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
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { byPrincipal } from "#public/schedules/scope.js";
import { declared } from "#runtime/types.js";
import { loadScheduleCollectionDefinition } from "#runtime/schedules/load-collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { loadCompiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { once } from "#tools/approval/policies.js";
import { evaluateApproval } from "#approval/evaluation.js";
import { serializeInputSchema } from "#tools/schema.js";
import type { ToolDefinition } from "#tools/definition.js";
import type { ScheduleOccurrenceEvent, ScheduleRecord } from "#public/schedules/subscription.js";

// An occurrence runs on Workflow, the durable host a step bundle installs; this realm loads none.
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
      description: "Your own workflows.",
      inputSchema: z.object({ task: z.string() }).strict(),
      provider,
      // One preparation for every scope, told which scope it acts for.
      preparePayload: (input, context) => ({ task: input.task, target: context.scopeName }),
      scopes: {
        personal: byPrincipal,
        channel: {
          description: "Channel workflows.",
          id: "team-workflows",
          resolve: () => ["channel", "C1"],
          approval: {
            list: () => "user-approval",
            // A request-only policy object gates no responses, as for one collection.
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
      // The agent offers the definition's one slot, built from the scopes it resolved.
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
            description: expect.stringMatching(
              /"personal": Your own workflows\..*"channel": Channel workflows\./u,
            ),
          },
        },
      });
      expect(create.description).not.toContain("Your own workflows.");

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
      // Each call reached its own scope: its stored collection, namespace, and prepared payload.
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

      // The channel's response policy gates the shared tool. The personal scope sets none, so
      // it keeps the default: only the requester answers, whoever else is in the conversation.
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
      // An anonymous request has no requester to match, as without a response policy.
      await expect(response(answer(input("personal"), null, bob))).resolves.toEqual({
        status: "allowed",
      });
      // The same holds for an operation without a prepared write.
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

      // A remembered approval stays with the scope it was given for.
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

      // An occurrence runs its scope's `run`, or the definition's when the scope has none.
      await invoke.execute(invoked("personal"), {} as never);
      await invoke.execute(invoked("channel"), {} as never);
      expect(ran).toEqual([
        "shared run: Send the personal digest",
        "channel run: Send the channel digest",
      ]);

      // A queue delivery names the stored collection and gets that scope's definition.
      await expect(loadScheduleCollectionDefinition(bundle, "team-workflows")).resolves.toBe(
        resolved[1]!.definition,
      );

      // Code reaches a scope through the client by naming it.
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
});
