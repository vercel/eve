import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import { eveChannel } from "#eve-channel/index.js";
import { executeTask } from "#evals/runner/execute-task.js";
import { createEvalTargetHandle } from "#evals/target.js";
import { workflowEntry } from "#execution/session/entry.js";
import { reportStubFailureStep } from "#execution/tool-stubs/steps.js";
import { dispatchWorkflowSessionCommand } from "#execution/workflow-runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { failingDeployWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { start, type Run } from "#internal/workflow/runtime.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
import { parseToolStubs } from "#tool-stubs/rules.js";
import { STUB_CONTEXT_KEY } from "#tool-stubs/types.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

it.each(["output processing", "failure reporting", "injected error"])(
  "verifies an eval with a failure in %s",
  async (failure) => {
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              task: failingDeployWorkflow,
              toModelOutput: () => {
                if (failure === "output processing") throw new Error("Invalid deployment result.");
                return { type: "text", value: "stubbed" };
              },
            }),
          }),
        },
      ],
    });
    const statusRoute = eveChannel({
      auth: () => ({
        allowToolStubs: true,
        principalId: "eval-runner",
        principalType: "service",
        authenticator: "test",
        attributes: {},
      }),
    }).routes!.find((route) => route.path.endsWith("/stubs"))!;
    await runtime.run(async () => {
      let run: Run<unknown> | undefined;
      // Simulate HTTP requests in memory while running the real workflow and status route.
      const originalFetch = globalThis.fetch;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        if (url.origin !== "https://eve.test") return await originalFetch(request, init);
        if (url.pathname === "/eve/v1/session") {
          const body = JSON.parse(String(init?.body));
          run = await start(workflowEntry, [
            {
              kind: "initial",
              ownerDeploymentId: "dpl_inline",
              input: {},
              serializedContext: {
                ...buildSerializedContext({ channelKind: "http" }),
                [STUB_CONTEXT_KEY]: {
                  token: "runner-output-failure",
                  rules: parseToolStubs(body.stubs),
                },
              },
            },
          ]);
          await waitForHook({ runId: run.runId }, { token: "runner-output-failure" });
          return Response.json({ sessionId: run.runId }, { status: 202 });
        }
        if (url.pathname.endsWith("/stubs")) {
          return (await statusRoute.handler(new Request(url), {
            ...mockAgentRouteArgs(),
            ...mockChannelContext(() => {
              throw new Error("Unexpected channel dispatch.");
            }),
            attachSession: () => {
              throw new Error("Unexpected session attachment.");
            },
            to: () => {
              throw new Error("Unexpected remote dispatch.");
            },
            waitUntil: () => undefined,
            requestIp: "127.0.0.1",
            params: { sessionId: run!.runId },
          })) as Response;
        }
        if (url.pathname.endsWith("/stream")) {
          return new Response(run!.getReadable<Uint8Array>(), {
            headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
          });
        }
        const body = JSON.parse(String(init?.body));
        await dispatchWorkflowSessionCommand({
          sessionId: run!.runId,
          command: handoffFollowUp("dpl_inline", body.message, "eval-message"),
        });
        return Response.json(
          { sessionId: run!.runId, deliveryId: "eval-message" },
          { status: 200 },
        );
      });
      try {
        const client = new Client({ host: "https://eve.test" });
        const outcome = await executeTask({
          client,
          target: createEvalTargetHandle({
            capabilities: { devRoutes: true },
            client,
            kind: "local",
            url: "https://eve.test",
          }),
          evaluation: {
            _tag: "EveEval",
            id: "bad-task-output",
            async test(t) {
              const session = await t.session({
                stubs: [
                  {
                    id: "deploy",
                    tool: "deploy_service",
                    outcome:
                      failure === "injected error"
                        ? { throw: { message: "Service unavailable" } }
                        : { response: "stubbed" },
                  },
                ],
              });
              const turn = await session.send('Run deploy_service with service "api"');
              turn.expectOk();
              turn.calledTool("deploy_service", { count: 1 });
              if (failure === "injected error") {
                turn.eventsSatisfy("the background task failed", (events) =>
                  events.some(
                    (event) => event.type === "task.settled" && event.data.status === "failed",
                  ),
                );
              }
              if (failure === "failure reporting") {
                await reportStubFailureStep(
                  { token: "unavailable-playback", rootSessionId: run!.runId, rules: [] },
                  "deploy",
                  "Invalid deployment result.",
                );
              }
            },
          },
        });
        expect(outcome.result.status).toBe("waiting");
        expect(outcome.assertions.length).toBeGreaterThan(0);
        expect(outcome.assertions.filter((assertion) => !assertion.passed)).toEqual([]);
        if (failure === "injected error") {
          expect(outcome.error).toBeUndefined();
          return;
        }
        expect(outcome.error).toContain(
          failure === "output processing"
            ? 'Stubbed tool "deploy_service" failed during output processing.'
            : "Tool stub session failed before verification.",
        );
      } finally {
        fetch.mockRestore();
        await run?.cancel();
      }
    });
  },
);
