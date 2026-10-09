import { FatalError } from "#compiled/@workflow/errors/index.js";
import { STUB_FAILURE_NAMESPACE, stubResponseNamespace } from "#tool-stubs/types.js";
import { describe, expect, it, vi } from "vitest";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { dispatchWorkflowSessionCommand } from "#execution/workflow-runtime.js";
import { readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY } from "#tool-stubs/types.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { defineTool } from "#tools/definition.js";
import { createWorkflowToolRuntime } from "#internal/testing/workflow-tool-run-harness.js";
import {
  failingDeployWorkflow,
  failingServeWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { always } from "#tools/approval/policies.js";

describe("tool replacement through the session runtime", () => {
  it.each(["ordinary", "execute", "task", "serve"] as const)(
    "records %s output conversion failures even when the agent recovers",
    async (entryPoint) => {
      let liveCalls = 0;
      let projections = 0;
      const definition = {
        description: "Deploy a service.",
        inputSchema: {
          type: "object" as const,
          properties: { service: { type: "string" as const } },
          required: ["service"],
        },
        toModelOutput: () => {
          projections++;
          throw new Error("Invalid deployment result.");
        },
      };
      const runtime = await createTestRuntime({
        modules: [
          {
            logicalPath: "tools/deploy_service.ts",
            loadNamespace: async () => ({
              default:
                entryPoint === "ordinary"
                  ? defineTool({
                      ...definition,
                      execute: () => {
                        liveCalls++;
                        return "live";
                      },
                    })
                  : entryPoint === "execute"
                    ? defineWorkflowTool({ ...definition, execute: failingDeployWorkflow })
                    : entryPoint === "task"
                      ? defineWorkflowTool({ ...definition, task: failingDeployWorkflow })
                      : defineWorkflowTool({ ...definition, serve: failingServeWorkflow }),
            }),
          },
        ],
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: 'Run deploy_service with service "api"' },
            serializedContext: {
              ...buildSerializedContext({ channelKind: "http" }),
              [STUB_CONTEXT_KEY]: {
                token: "failed-output-playback",
                rules: [{ id: "deploy", tool: "deploy_service", outcome: { response: "stubbed" } }],
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = await stream.nextTurn();
          expect(projections).toBeGreaterThan(0);
          expect(liveCalls).toBe(0);
          if (entryPoint === "task" || entryPoint === "serve") {
            expect(filterEventsByType(events, "turn.failed")).toEqual([]);
            expect(
              filterEventsByType(events, "task.settled").map((event) => event.data),
            ).toContainEqual(expect.objectContaining({ status: "completed", output: "stubbed" }));
          }
          expect(await readStubFailure(run.runId)).toBe(
            'Stubbed tool "deploy_service" failed during output processing.',
          );
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
  );

  it.each(["ordinary", "execute", "task", "serve"] as const)(
    "reports an injected %s failure and lets a new call succeed after handoff",
    async (entryPoint) => {
      const live = vi.fn(() => "live");
      const definition = {
        description: "Deploy a service.",
        inputSchema: {
          type: "object" as const,
          properties: { service: { type: "string" as const } },
          required: ["service"],
        },
      };
      const runtime = await createTestRuntime({
        modules: [
          {
            logicalPath: "tools/deploy_service.ts",
            loadNamespace: async () => {
              switch (entryPoint) {
                case "ordinary":
                  return { default: defineTool({ ...definition, execute: live }) };
                case "execute":
                  return {
                    default: defineWorkflowTool({ ...definition, execute: failingDeployWorkflow }),
                  };
                case "task":
                  return {
                    default: defineWorkflowTool({ ...definition, task: failingDeployWorkflow }),
                  };
                case "serve":
                  return {
                    default: defineWorkflowTool({ ...definition, serve: failingServeWorkflow }),
                  };
              }
            },
          },
        ],
      });
      await runtime.run(async () => {
        const message = 'Run deploy_service with service "api"';
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message },
            serializedContext: {
              ...buildSerializedContext({ channelKind: "http" }),
              [STUB_CONTEXT_KEY]: {
                token: "injected-error-playback",
                rules: [
                  {
                    id: "deploy",
                    tool: "deploy_service",
                    outcomes: [
                      { throw: { name: "TimeoutError", message: "Deployment service timed out" } },
                      { response: { state: "recovered" } },
                    ],
                  },
                ],
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = await stream.nextTurn();
          const failures =
            entryPoint === "task" || entryPoint === "serve"
              ? filterEventsByType(events, "task.settled").map((event) => event.data)
              : filterEventsByType(events, "action.result").map((event) => event.data);
          expect(failures).toContainEqual(expect.objectContaining({ status: "failed" }));
          expect(JSON.stringify(failures)).toContain("Deployment service timed out");
          expect(filterEventsByType(events, "turn.failed")).toEqual([]);
          expect(await readStubFailure(run.runId)).toBeUndefined();
          await dispatchWorkflowSessionCommand({
            sessionId: run.runId,
            command: handoffFollowUp("dpl_successor", message, "retry-after-injected-error"),
          });
          const retried = await stream.nextTurn();
          const results =
            entryPoint === "task" || entryPoint === "serve"
              ? filterEventsByType(retried, "task.settled").map((event) => event.data)
              : filterEventsByType(retried, "action.result").map((event) => event.data.result);
          expect(results).toContainEqual(
            expect.objectContaining({ output: { state: "recovered" } }),
          );
          expect(filterEventsByType(retried, "turn.failed")).toEqual([]);
          expect(live).not.toHaveBeenCalled();
          expect(await readStubFailure(run.runId)).toBeUndefined();
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
  );

  it.each([false, true])(
    "ends the active session when playback fails (handoff: %s)",
    async (handoff) => {
      const runtime = await createTestRuntime({
        modules: [
          {
            logicalPath: "tools/deploy_service.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Deploy a service.",
                inputSchema: {
                  type: "object",
                  properties: { service: { type: "string" } },
                  required: ["service"],
                },
                execute: () => {
                  throw new Error("Live execution must not run.");
                },
              }),
            }),
          },
        ],
      });
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: 'Run deploy_service with service "api"' },
            serializedContext: {
              ...buildSerializedContext({ channelKind: "http" }),
              [STUB_CONTEXT_KEY]: {
                token: "failed-playback",
                rules: [{ id: "deploy", tool: "deploy_service", outcome: { response: "stubbed" } }],
              },
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        const world = await getWorld();
        const append = world.streams.write.bind(world.streams);
        let write: ReturnType<typeof vi.spyOn> | undefined;
        try {
          await stream.nextTurn();
          write = vi.spyOn(world.streams, "write").mockImplementation(async (...args) => {
            const namespace = Buffer.from(args[1].split("_").at(-1)!, "base64url").toString();
            if (
              namespace !== STUB_FAILURE_NAMESPACE &&
              namespace.startsWith(stubResponseNamespace(""))
            )
              throw new FatalError("Playback transport failed.");
            return await append(...args);
          });
          await dispatchWorkflowSessionCommand({
            sessionId: run.runId,
            command: handoff
              ? handoffFollowUp(
                  "dpl_successor",
                  'Run deploy_service with service "api"',
                  "failed-stub-handoff",
                )
              : { kind: "send", payload: { message: 'Run deploy_service with service "api"' } },
          });
          const events = await stream.nextTurn();
          expect(filterEventsByType(events, "session.failed")).toHaveLength(1);
          expect(filterEventsByType(events, "session.completed")).toHaveLength(0);
          expect(await readStubFailure(run.runId)).toBe("Tool stub playback failed.");
          expect(
            await dispatchWorkflowSessionCommand({
              sessionId: run.runId,
              command: { kind: "send", payload: { message: "Hello" } },
            }),
          ).toMatchObject({ status: "session_not_active" });
          if (handoff) {
            await expect(run.returnValue).resolves.toEqual({ output: "" });
          } else {
            await expect(run.returnValue).rejects.toThrow("Agent workflow failed.");
          }
        } finally {
          write?.mockRestore();
          stream.dispose();
        }
      });
    },
  );

  it("isolates same-named root and child tools while sharing root playback", async () => {
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: () => {
                throw new Error("Live execution must not run.");
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              token: "inherited-playback",
              rules: [
                {
                  id: "deploy",
                  tool: "deploy_service",
                  outcome: { response: { state: "root" } },
                },
                {
                  id: "child-deploy",
                  tool: "agent/deploy_service",
                  outcome: { response: { state: "child" } },
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const rootEvents = await stream.nextTurn();
        expect(
          filterEventsByType(rootEvents, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "root" } }));
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { message: 'Delegate to a subagent: Run deploy_service with service "api"' },
          },
        });
        const events = await stream.nextTurn();
        const children = filterEventsByType(events, "agent.started");
        expect(children).toHaveLength(1);
        const settlements = filterEventsByType(events, "task.settled");
        expect(
          settlements.some((event) => JSON.stringify(event.data.output).includes("child")),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("replaces the whole agent tool without starting a remote or local agent", async () => {
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Delegate to a subagent: Say hello." },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              token: "whole-agent-playback",
              rules: [
                { id: "agent", tool: "agent", outcome: { response: "Hello from the stub." } },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const events = await stream.nextTurn();
        expect(filterEventsByType(events, "agent.started")).toEqual([]);
        expect(
          filterEventsByType(events, "task.settled").map((event) => event.data),
        ).toContainEqual(
          expect.objectContaining({ status: "completed", output: "Hello from the stub." }),
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("keeps approval gates and does not consume a response for a denied call", async () => {
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              approval: always(),
              execute: () => {
                throw new Error("Live execution must not run.");
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            "eve.capabilities": { requestInput: true },
            [STUB_CONTEXT_KEY]: {
              token: "approval-playback",
              rules: [
                {
                  id: "deploy",
                  tool: "deploy_service",
                  outcomes: [{ response: { first: true } }, { response: { first: false } }],
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const pending = await stream.nextTurn();
        const request = filterEventsByType(pending, "input.requested")[0]!.data.requests[0]!;
        expect(filterEventsByType(pending, "action.result")).toEqual([]);
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { inputResponses: [{ requestId: request.requestId, optionId: "deny" }] },
          },
        });
        await stream.nextTurn();
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: { kind: "send", payload: { message: 'Run deploy_service with service "api"' } },
        });
        const retry = await stream.nextTurn();
        const next = filterEventsByType(retry, "input.requested")[0]!.data.requests[0]!;
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { inputResponses: [{ requestId: next.requestId, optionId: "approve" }] },
          },
        });
        const approved = await stream.nextTurn();
        expect(
          filterEventsByType(approved, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { first: true } }));
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
  it("keeps sequence progress across a deployment handoff and runs unmatched calls normally", async () => {
    let liveCalls = 0;
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: async () => {
                liveCalls++;
                return { state: "live" };
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              token: "ordinary-tool-playback",
              rules: [
                {
                  id: "api",
                  tool: "deploy_service",
                  match: { service: { const: "api" } },
                  outcomes: [
                    { response: { state: "pending" } },
                    { response: { state: "completed" } },
                  ],
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const first = await stream.nextTurn();
        expect(
          filterEventsByType(first, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "pending" } }));
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: handoffFollowUp(
            "dpl_successor",
            'Run deploy_service with service "api"',
            "stub-handoff",
          ),
        });
        const second = await stream.nextTurn();
        expect(
          filterEventsByType(second, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "completed" } }));
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: { kind: "send", payload: { message: 'Run deploy_service with service "web"' } },
        });
        const third = await stream.nextTurn();
        expect(
          filterEventsByType(third, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "live" } }));
        expect(liveCalls).toBe(1);
        expect(await readStubFailure(run.runId)).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("replaces a workflow body while retaining its normal result events", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "stubbed-workflow",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              token: "workflow-tool-playback",
              rules: [
                {
                  id: "deploy",
                  tool: "deploy_service",
                  outcome: { response: { state: "stubbed" } },
                },
                {
                  id: "child-deploy",
                  tool: "agent/deploy_service",
                  outcome: { response: { state: "child-workflow" } },
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const events = await stream.nextTurn();
        expect(
          filterEventsByType(events, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "stubbed" } }));
        expect(filterEventsByType(events, "turn.failed")).toEqual([]);
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { message: 'Delegate to a subagent: Run deploy_service with service "api"' },
          },
        });
        const childEvents = await stream.nextTurn();
        expect(filterEventsByType(childEvents, "agent.started")).toHaveLength(1);
        expect(
          filterEventsByType(childEvents, "task.settled").some((event) =>
            JSON.stringify(event.data.output).includes("child-workflow"),
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
