import { hydrateWorkflowReturnValue } from "@workflow/core/serialization";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { executeSleepTool, SLEEP_INPUT_SCHEMA } from "#execution/tools/sleep.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import {
  askThenRaceWorkflow,
  authorizedDeployWorkflow,
  backgroundDeployWorkflow,
  confirmDeployWorkflow,
  deployServiceWorkflow,
  failingDeployWorkflow,
  holdUntilAbortedWorkflow,
  reportingDeployWorkflow,
  stepThenRaceWorkflow,
  stepReferenceWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import {
  defineWorkflowTool,
  type BlockingWorkflowToolDefinition,
} from "#tools/workflow-definition.js";
import { serializeInputSchema, toInputSchema } from "#tools/schema.js";

const DEPLOY_INPUT_SCHEMA = toInputSchema({
  additionalProperties: false,
  properties: { service: { type: "string" } },
  required: ["service"],
  type: "object",
});

function buildSerializedContext(input: {
  readonly acceptedDeploymentId?: string;
  readonly continuationToken: string;
  readonly mode: "conversation" | "task";
  readonly requestInput?: boolean;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.capabilities": { requestInput: input.requestInput ?? false },
    "eve.channel": { kind: "http", state: {} },
    ...(input.acceptedDeploymentId === undefined
      ? {}
      : {
          "eve.channelDelivery": {
            acceptedDeploymentId: input.acceptedDeploymentId,
            channelKind: "http",
            channelName: "test",
            deliveryId: "delivery-initial",
          },
        }),
    "eve.continuationToken": input.continuationToken,
    "eve.mode": input.mode,
  };
}

/**
 * Registers one fixture workflow as an authored tool. The fixture module
 * passed through the test tier's client transform, so `execute` is the stub
 * the real pipeline produces: a function carrying its `workflowId`.
 */
async function createWorkflowToolRuntime(input: {
  readonly agentName: string;
  readonly background?: boolean;
  readonly execute: (...args: never[]) => unknown;
  readonly inputSchema?: ResolvedToolDefinition["inputSchema"];
  readonly toolName: string;
}): Promise<TestRuntime> {
  return await createTestRuntime({
    agent: { name: input.agentName },
    modules: [
      {
        logicalPath: `tools/${input.toolName}.ts`,
        loadNamespace: async () => ({
          default: defineWorkflowTool({
            execution: input.background === true ? "background" : undefined,
            description: `Deploys a service (${input.toolName}).`,
            execute: input.execute as BlockingWorkflowToolDefinition["execute"],
            inputSchema: serializeInputSchema(input.inputSchema ?? DEPLOY_INPUT_SCHEMA) ?? {},
          }),
        }),
      },
    ],
  });
}

/** Ids of every workflow tool run in the shared world, so a test can spot the one it started. */
async function listWorkflowToolRunIds(): Promise<Set<string>> {
  const world = await getWorld();
  const page = await world.runs.list({ pagination: { limit: 100 } });
  return new Set(
    page.data
      .filter(
        (entry: { readonly workflowName?: string }) =>
          entry.workflowName === workflowToolRunWorkflowReference.workflowId,
      )
      .map((entry: { readonly runId: string }) => entry.runId),
  );
}

/** Polls until exactly one workflow tool run exists that was not in `before`. */
async function waitForNewWorkflowToolRun(
  before: ReadonlySet<string>,
  timeout = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const started = [...(await listWorkflowToolRunIds())].filter((runId) => !before.has(runId));
    if (started.length === 1) return started[0]!;
    if (started.length > 1)
      throw new Error(`Expected one new workflow tool run, found ${started.length}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a workflow tool run to start.");
}

/** Polls one run until it reaches a terminal status, returning that status. */
async function waitForWorkflowToolRunTerminal(runId: string, timeout = 15_000): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await getRun(runId).status;
    if (terminal.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach a terminal status.`);
}

function eventsText(events: readonly { readonly data?: unknown }[]): string {
  return events.map((event) => JSON.stringify(event.data ?? null)).join("\n");
}

describe("workflow step authorization", () => {
  it.each([false, true])(
    "resolves a user token inside a step (background=%s)",
    async (background) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-step-token",
        background,
        execute: authorizedDeployWorkflow,
        toolName: "deploy_service",
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: 'Run deploy_service with service "preauthorized"' },
            serializedContext: {
              ...buildSerializedContext({
                continuationToken: "http:step-token",
                mode: "conversation",
              }),
              "eve.auth": {
                attributes: {},
                authenticator: "test-idp",
                issuer: "test-idp",
                principalId: "user-1",
                principalType: "user",
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          let text = "";
          for (let i = 0; i < 5 && !text.includes("authenticatedAs"); i++)
            text += JSON.stringify(await stream.nextTurn());
          expect(text).toContain("authenticatedAs");
          expect(text).toContain("user-1");
          expect(text).not.toContain("secret:");
          expect(text).not.toContain("authorization.required");
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it.each([
    { background: false, service: "interactive" },
    { background: true, service: "interactive" },
    { background: false, service: "retry" },
    { background: true, service: "retry" },
  ])(
    "parks on its own callback and resumes the step (background=$background, service=$service)",
    async ({ background, service }) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-step-auth",
        background,
        execute: authorizedDeployWorkflow,
        toolName: "deploy_service",
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: `Run deploy_service with service "${service}"` },
            serializedContext: {
              ...buildSerializedContext({
                continuationToken: "http:step-auth",
                mode: "conversation",
                requestInput: true,
              }),
              "eve.auth": {
                attributes: {},
                authenticator: "test-idp",
                issuer: "test-idp",
                principalId: "user-1",
                principalType: "user",
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = [];
          for (
            let i = 0;
            i < 5 && filterEventsByType(events, "authorization.required").length === 0;
            i++
          )
            events.push(...(await stream.nextTurn()));
          const required = filterEventsByType(events, "authorization.required")[0]!;
          expect(required).toBeDefined();
          const url = new URL(required.data.webhookUrl!);
          const parts = url.pathname.split("/").map(decodeURIComponent);
          const token = parts.at(-1)!;
          expect(token).not.toBe(`${run.runId}:auth`);
          const world = await getWorld();
          const executorRunId = (await world.hooks.getByToken(token)).runId;
          url.searchParams.set("code", "approved");
          await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: "another-attempt", name: required.data.name },
          } as never);
          await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: "another-provider" },
          } as never);
          const response = await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: required.data.name },
          } as never);
          expect(response.status).toBe(200);
          for (let i = 0; i < 6 && !JSON.stringify(events).includes("authenticatedAs"); i++)
            events.push(...(await stream.nextTurn()));
          expect(
            filterEventsByType(events, "authorization.completed").map(
              (event) => event.data.outcome,
            ),
          ).toEqual(["authorized"]);
          const text = JSON.stringify(events);
          expect(text).toContain("authenticatedAs");
          expect(text).toContain("user-1");
          expect(text).not.toContain("secret:");
          const steps = await world.steps.list({
            runId: executorRunId,
            pagination: { limit: 1000 },
          });
          expect(
            steps.data.filter((step) => step.stepName.endsWith("//planDeployStep")),
          ).toHaveLength(1);
          const attempts = steps.data.filter((step) =>
            step.stepName.endsWith("//authorizedDeployStep:eve-authorization"),
          );
          expect(attempts).toHaveLength(2);
          if (service === "retry") {
            expect(attempts.map((step) => step.attempt).sort()).toEqual([1, 2]);
            const retried = attempts.find((step) => step.attempt === 2)!;
            const marker = getRun(executorRunId).getReadable({
              namespace: `eve.authorization.${retried.stepId}.${required.data.attemptId}`,
            });
            const reader = marker.getReader();
            try {
              expect((await reader.read()).value).toBe(true);
            } finally {
              await reader.cancel();
              reader.releaseLock();
            }
          }
          for (const step of attempts) {
            const output = await hydrateWorkflowReturnValue(step.output, executorRunId, undefined);
            expect(JSON.stringify(output)).not.toContain("secret:");
          }
          const duplicate = await handleConnectionCallbackRequest(new Request(url), {
            params: { token, attemptId: required.data.attemptId!, name: required.data.name },
          } as never);
          expect(duplicate.status).toBe(404);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it.each([
    { background: false, disposition: "denied" },
    { background: true, disposition: "denied" },
    { background: false, disposition: "rejected" },
    { background: true, disposition: "rejected" },
    { background: false, disposition: "cancel" },
    { background: true, disposition: "cancel" },
  ])(
    "closes authorization on $disposition (background=$background)",
    async ({ background, disposition }) => {
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-step-auth-failure",
        background,
        execute: authorizedDeployWorkflow,
        toolName: "deploy_service",
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: `Run deploy_service with service "${disposition}"` },
            serializedContext: {
              ...buildSerializedContext({
                continuationToken: "http:step-auth-failure",
                mode: "conversation",
                requestInput: true,
              }),
              "eve.auth": {
                attributes: {},
                authenticator: "test-idp",
                issuer: "test-idp",
                principalId: "user-1",
                principalType: "user",
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = [];
          for (
            let i = 0;
            i < 5 && filterEventsByType(events, "authorization.required").length === 0;
            i++
          )
            events.push(...(await stream.nextTurn()));
          const required = filterEventsByType(events, "authorization.required")[0]!;
          expect(required).toBeDefined();
          const url = new URL(required.data.webhookUrl!);
          const token = decodeURIComponent(url.pathname.split("/").at(-1)!);
          const world = await getWorld();
          const executorRunId = (await world.hooks.getByToken(token)).runId;
          const params = { token, attemptId: required.data.attemptId!, name: required.data.name };
          if (disposition === "cancel") {
            await resumeSessionInbox(
              sessionCommandHookToken(run.runId),
              background ? { kind: "cancel", tasks: true } : { kind: "cancel", turnId: "turn_0" },
            );
          } else {
            url.searchParams.set("code", disposition === "denied" ? "denied" : "approved");
            expect(
              (await handleConnectionCallbackRequest(new Request(url), { params } as never)).status,
            ).toBe(200);
          }
          if (disposition === "cancel") {
            if (!background) {
              events.push(...(await stream.nextTurn()));
              expect(filterEventsByType(events, "turn.cancelled")).toHaveLength(1);
            }
          } else {
            for (
              let i = 0;
              i < 6 && filterEventsByType(events, "authorization.completed").length === 0;
              i++
            )
              events.push(...(await stream.nextTurn()));
            expect(
              filterEventsByType(events, "authorization.completed").map(
                (event) => event.data.outcome,
              ),
            ).toEqual(["failed"]);
          }
          expect(filterEventsByType(events, "authorization.required")).toHaveLength(1);
          await waitForWorkflowToolRunTerminal(executorRunId);
          expect(
            (await handleConnectionCallbackRequest(new Request(url), { params } as never)).status,
          ).toBe(404);
          expect(JSON.stringify(events)).not.toContain("secret:");
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );
});

describe("workflow tools", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("invokes restored step references with bound arguments and receivers", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-step-reference",
      execute: stepReferenceWorkflow,
      toolName: "deploy_service",
    });
    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:step-reference",
            mode: "task",
          }),
        },
      ]);
      return String((await run.returnValue).output);
    });
    expect(output).toContain('"argument":"plan:api"');
    expect(output).toContain('"receiver":"api"');
  });
  it("runs the framework sleep tool through the workflow tool path", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-sleep",
      execute: executeSleepTool,
      inputSchema: SLEEP_INPUT_SCHEMA,
      toolName: "sleep",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Run sleep" },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:workflow-tool-sleep",
            mode: "task",
          }),
        },
      ]);
      const result = await run.returnValue;
      return String(result.output);
    });

    expect(output).toContain('"waitedSeconds":1');
  });

  it("parks the turn on a workflow tool and resumes with its return value", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-wait",
      execute: deployServiceWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:workflow-tool-wait",
            mode: "task",
          }),
        },
      ]);
      const result = await run.returnValue;
      return String(result.output);
    });

    expect(output).toContain('"plan":"plan:api"');
    expect(output).toContain('"callId":"call_deploy_service');
  });

  it("settles the call with an error when the workflow body throws", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-fail",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:workflow-tool-fail",
            mode: "task",
          }),
        },
      ]);
      const result = await run.returnValue;
      return String(result.output);
    });

    expect(output).toContain("deploy of api exploded");
  });

  it.each(["inline", "child"] as const)(
    "routes workflow reports, human input, and outcome on the %s owner",
    async (owner) => {
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-tool-hitl",
        execute: confirmDeployWorkflow,
        toolName: "confirm_deploy",
      });

      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: 'Run confirm_deploy with service "api"' },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: owner === "inline" ? "dpl_inline" : undefined,
              continuationToken: "http:workflow-tool-hitl",
              mode: "conversation",
              requestInput: true,
            }),
          },
        ]);
        const stream = captureTurnEvents(run);

        try {
          const asked = await stream.nextTurn();
          const world = await getWorld();
          const parentHooks = (await world.hooks.list({ runId: run.runId })).data;
          expect(
            parentHooks.some((hook) => hook.token === `${run.runId}:turn-control:0:inbox`),
          ).toBe(owner === "inline");
          expect(
            filterEventsByType(asked, "action.partial").map((event) => event.data.result.output),
          ).toEqual(["awaiting approval"]);
          const requested = filterEventsByType(asked, "input.requested");
          expect(requested).toHaveLength(1);
          const request = (requested[0] as InputRequestedStreamEvent).data.requests[0]!;
          expect(request).toMatchObject({
            action: { input: { service: "api" }, kind: "tool-call", toolName: "confirm_deploy" },
            display: "confirmation",
            kind: "question",
            prompt: "Apply plan:api?",
          });
          expect(request.options?.map((option) => option.id)).toEqual(["approve", "cancel"]);

          const commandToken = sessionCommandHookToken(run.runId);
          await waitForHook(run, { token: commandToken });
          await resumeSessionInbox(commandToken, {
            kind: "send",
            payload: { inputResponses: [{ optionId: "approve", requestId: request.requestId }] },
          });

          const answered = await stream.nextTurn();
          const progress = answered.findIndex(
            (event) =>
              event.type === "action.partial" && event.data.result.output === "approval received",
          );
          const resultIndex = answered.findIndex(
            (event) =>
              event.type === "action.result" &&
              event.data.result.kind === "tool-result" &&
              event.data.result.toolName === "confirm_deploy",
          );
          expect(progress).toBeGreaterThanOrEqual(0);
          expect(resultIndex).toBeGreaterThan(progress);
          const results = filterEventsByType(answered, "action.result");
          expect(results.map((event) => JSON.stringify(event.data.result.output))).toContainEqual(
            JSON.stringify({ approved: true, service: "api" }),
          );
          expect(filterEventsByType(answered, "turn.failed")).toHaveLength(0);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it("times out a hook raced against a sleep when it is not resumed", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-deadline",
      execute: stepThenRaceWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Run deploy_service" },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-deadline",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const settled = await stream.nextTurn();
        const outputs = filterEventsByType(settled, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
        expect(filterEventsByType(settled, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("lets a deadline win a race against an unanswered ask", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-ask-deadline",
      execute: askThenRaceWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-ask-deadline",
            mode: "conversation",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        // Asking parks the turn; the sleep then wins and the same turn resumes.
        const asked = await stream.nextTurn();
        expect(filterEventsByType(asked, "input.requested")).toHaveLength(1);

        const resumed = await stream.nextTurn();
        const outputs = filterEventsByType(resumed, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
        expect(filterEventsByType(resumed, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it.each(["inline", "child"] as const)(
    "cancels the run when the waiting turn is cancelled and lets the body clean up (%s)",
    async (owner) => {
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-tool-cancel",
        execute: holdUntilAbortedWorkflow,
        toolName: "deploy_service",
      });

      await runtime.run(async () => {
        const before = await listWorkflowToolRunIds();
        const run = await start(workflowEntry, [
          {
            input: { message: 'Run deploy_service with service "api"' },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: owner === "inline" ? "dpl_inline" : undefined,
              continuationToken: "http:workflow-tool-cancel",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);

        try {
          const workflowToolRunId = await waitForNewWorkflowToolRun(before);
          await waitForHook({ runId: workflowToolRunId });
          const commandToken = sessionCommandHookToken(run.runId);
          await waitForHook(run, { token: commandToken });
          await resumeSessionInbox(commandToken, { kind: "cancel", turnId: "turn_0" });

          // The body is holding in a step that received ctx.abortSignal, so the
          // run ends well inside its grace period once the step rejects and
          // `finally` runs; a run that ignored the signal would still be running.
          expect(await waitForWorkflowToolRunTerminal(workflowToolRunId)).toBe("completed");

          await resumeSessionInbox(commandToken, {
            kind: "send",
            payload: { message: "Thanks, no deploy today." },
          });
          const next = await stream.nextTurn();
          expect(filterEventsByType(next, "turn.started")).toHaveLength(1);
          expect(filterEventsByType(next, "turn.failed")).toHaveLength(0);
          expect(next.at(-1)?.type).toBe("session.waiting");
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it.each(["inline", "child"] as const)(
    "runs a background workflow tool as its task's executor (%s)",
    async (owner) => {
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
      const runtime = await createWorkflowToolRuntime({
        agentName: "workflow-tool-background",
        execute: backgroundDeployWorkflow,
        toolName: "report_deploy",
      });

      await runtime.run(async () => {
        enableBackgroundTool(runtime, "report_deploy");

        const run = await start(workflowEntry, [
          {
            input: { message: 'Run report_deploy with service "api"' },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: owner === "inline" ? "dpl_inline" : undefined,
              continuationToken: "http:workflow-tool-background",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);

        try {
          const receiptTurn = await stream.nextTurn();
          const receipt = filterEventsByType(receiptTurn, "action.result").find(
            (event) => event.data.result.kind === "tool-result",
          );
          expect(receipt?.data.result.output).toMatchObject({ status: "working" });
          expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);

          const notifications: string[] = [];
          for (
            let turn = 0;
            turn < 3 && !notifications.some((text) => text.includes("is completed"));
            turn += 1
          ) {
            const woken = await stream.nextTurn();
            expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
            notifications.push(eventsText(filterEventsByType(woken, "message.received")));
          }
          const text = notifications.join("\n");
          expect(text).toContain("Review plan:api");
          expect(text).not.toContain("update: planned api");
          expect(text).toContain("is completed");
          expect(text).toContain("plan:api");
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    90_000,
  );

  it("streams a waiting tool's yields as action.partial and settles with its return", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-progress",
      execute: reportingDeployWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-progress",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const settled = await stream.nextTurn();
        const partials = filterEventsByType(settled, "action.partial").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(partials).toContainEqual(JSON.stringify("planned api"));
        const results = filterEventsByType(settled, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(results).toContainEqual(JSON.stringify({ plan: "plan:api" }));
        expect(filterEventsByType(settled, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("wakes the agent with the failure when a background workflow tool throws", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background-fail",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "deploy_service");

      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-background-fail",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const receiptTurn = await stream.nextTurn();
        expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);

        const notifications: string[] = [];
        for (
          let turn = 0;
          turn < 3 && !notifications.some((t) => t.includes("failed"));
          turn += 1
        ) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          notifications.push(eventsText(filterEventsByType(woken, "message.received")));
        }
        const text = notifications.join("\n");
        expect(text).toContain("(deploy_service) failed.");
        expect(text).toContain("deploy of api exploded");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 90_000);

  it("lets a background workflow tool ask now and act when answered", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background-hitl",
      execute: confirmDeployWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "confirm_deploy");

      const run = await start(workflowEntry, [
        {
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-background-hitl",
            mode: "conversation",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const receiptTurn = await stream.nextTurn();
        expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);
        expect(
          filterEventsByType(receiptTurn, "action.result").some(
            (event) =>
              event.data.result.kind === "tool-result" &&
              typeof event.data.result.output === "object" &&
              event.data.result.output !== null &&
              "taskId" in event.data.result.output,
          ),
        ).toBe(true);

        // The question arrives after the turn that called the tool ended.
        let request: InputRequestedStreamEvent["data"]["requests"][number] | undefined;
        for (let turn = 0; turn < 3 && request === undefined; turn += 1) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          request = (
            filterEventsByType(woken, "input.requested")[0] as InputRequestedStreamEvent | undefined
          )?.data.requests[0];
        }
        expect(request).toMatchObject({ kind: "question", prompt: "Apply plan:api?" });

        // The stable session inbox already took the task's wake, so it is
        // known to exist; answer through it directly.
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request!.requestId }] },
        });

        const notifications: string[] = [];
        for (
          let turn = 0;
          turn < 3 && !notifications.some((text) => text.includes("is completed"));
          turn += 1
        ) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          notifications.push(eventsText(filterEventsByType(woken, "message.received")));
        }
        const text = notifications.join("\n");
        expect(text).toContain("is completed");
        expect(text).toContain('\\"approved\\":true');
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 90_000);
});

/** Flags one manifest tool as `execution: "background"` under `experimental.tasks`. */
function enableBackgroundTool(runtime: TestRuntime, toolName: string): void {
  const artifacts = runtime.session.compiledArtifacts;
  if (artifacts === null) throw new Error("expected installed compiled artifacts");
  runtime.session.compiledArtifacts = {
    ...artifacts,
    manifest: {
      ...artifacts.manifest,
      config: artifacts.manifest.config,
      tools: artifacts.manifest.tools.map((tool) =>
        tool.name === toolName ? { ...tool, execution: "background" as const } : tool,
      ),
    },
  };
}
