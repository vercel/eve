import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { createStatefulMcpServer } from "#internal/testing/stateful-mcp-server.js";
import {
  deployServiceBody,
  deployServiceWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import agentTool from "#public/tools/agent.js";
import { workflow } from "#public/tools/workflow.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

installWorkflowSandboxRuntime();

afterEach(() => {
  vi.unstubAllGlobals();
});

const address = (runtime: Runtime, continuationToken: string) =>
  createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });

async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

async function violations(runtime: Runtime, sessionId: string): Promise<Violation[]> {
  const checker = createStreamChecker({ validate: schemaViolation });
  const found: Violation[] = [];
  let position = 0;
  for await (const record of await runtime.getLineStream(sessionId, { follow: false })) {
    if (!isStoredLine(record)) throw new Error(`Line ${position} isn't a stored line.`);
    found.push(...checker.check(record, position++));
  }
  return found;
}

type ProgramResults = unknown[];

function programModel(js: string, results: ProgramResults, toolName = "workflow") {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const delegated = /Summarize (\w+)/u.exec(JSON.stringify(prompt.at(-1)))?.[1];
        if (delegated !== undefined) {
          return tools?.some((offered) => offered.name === "eve__reply")
            ? toolCallsStreamResult([
                {
                  input: JSON.stringify({ status: "current", topic: delegated }),
                  toolCallId: `reply-${delegated}`,
                  toolName: "eve__reply",
                },
              ])
            : textStreamResult(`${delegated} are current.`);
        }
        const read = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : []))
            : [],
        );
        if (read.length === 0) {
          return toolCallsStreamResult([
            {
              input: JSON.stringify({ js }),
              toolCallId: "call-program",
              toolName,
            },
          ]);
        }
        if (results.length === 0) {
          const output = read.at(-1)!;
          results.push("value" in output ? output.value : output);
        }
        return textStreamResult("Done.");
      },
      modelId: "program-scripted",
      provider: "eve-test",
    }),
  );
}

function moduleEntry(logicalPath: string, definition: unknown) {
  return {
    loadNamespace: async () => ({ default: definition }),
    logicalPath,
  };
}

function tool(name: string, definition: unknown) {
  return moduleEntry(`tools/${name}.ts`, definition);
}

async function withProgramSession<T>(
  input: {
    readonly approval?: Parameters<typeof defineAgent>[0]["approval"];
    readonly js: string;
    readonly maxSubagents?: number;
    readonly modules?: readonly ReturnType<typeof moduleEntry>[];
    readonly toolName?: string;
    readonly tools: readonly ReturnType<typeof tool>[];
    readonly workflows?: readonly WorkflowBody[];
  },
  run: (session: {
    readonly alice: ReturnType<typeof address>;
    readonly results: ProgramResults;
    readonly runtime: Runtime;
  }) => Promise<T>,
): Promise<T> {
  const toolName = input.toolName ?? "workflow";
  const results: ProgramResults = [];
  const model = programModel(input.js, results, toolName);
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        ...(input.approval !== undefined && { approval: input.approval }),
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "program-session",
    },
    modules: [
      tool(
        toolName,
        workflow({
          ...(input.maxSubagents !== undefined && { maxSubagents: input.maxSubagents }),
          mode: "execute",
          tools: true,
        }),
      ),
      ...input.tools,
      ...(input.modules ?? []),
    ],
  });
  return await test.run(async () => {
    const runtime = createTestInProcessRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    for (const { body, workflowId } of input.workflows ?? [])
      runtime.registerWorkflow(workflowId, body);
    try {
      return await run({ alice: address(runtime, "alice-program"), results, runtime });
    } finally {
      await runtime.dispose();
    }
  });
}

function eventData<TType extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: TType,
): Extract<SessionStreamEvent, { readonly type: TType }>["data"][] {
  return events.flatMap((event) => (event.type === type ? [event.data as never] : []));
}

describe("workflow({ mode: 'execute', tools: true }) program step", () => {
  it("runs inline, deferred, and connection tools with search() and skips toModelOutput projections", async () => {
    const seen: string[] = [];
    const inlineToModelOutput = vi.fn(() => ({ type: "text" as const, value: "projected" }));
    const connectionToModelOutput = vi.fn(() => ({ type: "text" as const, value: "projected" }));
    vi.stubGlobal(
      "fetch",
      createStatefulMcpServer((server) => {
        server.registerTool("list_issues", { description: "List repository issues." }, () => ({
          content: [{ text: JSON.stringify([{ id: "ISS-1", status: "open" }]), type: "text" }],
        }));
      }).fetch,
    );

    const lookupOrder = tool(
      "lookup_order",
      defineTool({
        description: "Look up one order.",
        execute: async ({ id }: { id: string }) => {
          seen.push(id);
          return { id, status: id === "o2" ? "disputed" : "open" };
        },
        inputSchema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        toModelOutput: inlineToModelOutput,
      }),
    );
    const readNotes = tool(
      "read_notes",
      defineTool({
        deferred: true,
        description: "Read private order notes.",
        execute: async ({ id }: { id: string }) => ({ note: `note:${id}` }),
        inputSchema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
      }),
    );

    await withProgramSession(
      {
        js: `
          const found = await search({ query: "list_issues" });
          const orders = await Promise.all(["o1", "o2"].map((id) => tools.lookup_order({ id })));
          const disputed = orders.filter((order) => order.status === "disputed");
          const [note, issues] = await Promise.all([
            tools.read_notes({ id: disputed[0].id }),
            tools.tracker__list_issues({}),
          ]);
          console.log("top", found.results[0]?.tool);
          return { disputed: disputed[0].id, issues, note: note.note };
        `,
        modules: [
          moduleEntry(
            "connections/tracker.ts",
            defineMcpClientConnection({
              description: "Issue tracker.",
              toolCall: { toModelOutput: connectionToModelOutput },
              url: "https://tracker.example.com/mcp",
            }),
          ),
        ],
        toolName: "orchestrate",
        tools: [lookupOrder, readNotes],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Check orders and issues.", { auth: null });
        const result = await delivery.result();
        const events = await recorded(runtime, delivery.sessionId);

        expect(result.reply).toBe("Done.");
        expect(seen.sort()).toEqual(["o1", "o2"]);
        expect(inlineToModelOutput).not.toHaveBeenCalled();
        expect(connectionToModelOutput).not.toHaveBeenCalled();
        expect(results).toEqual([
          {
            calls: { completed: 4 },
            logs: ["top tracker__list_issues"],
            result: {
              disputed: "o2",
              issues: [{ id: "ISS-1", status: "open" }],
              note: "note:o2",
            },
          },
        ]);
        expect(
          eventData(events, "call.requested").map(({ callId, capability, owner }) => ({
            callId,
            name: capability.name,
            owner,
          })),
        ).toEqual([
          { callId: "call-program", name: "orchestrate", owner: { runId: expect.any(String) } },
          { callId: "call-program/2", name: "lookup_order", owner: { callId: "call-program" } },
          { callId: "call-program/3", name: "lookup_order", owner: { callId: "call-program" } },
          { callId: "call-program/4", name: "read_notes", owner: { callId: "call-program" } },
          {
            callId: "call-program/5",
            name: "tracker__list_issues",
            owner: { callId: "call-program" },
          },
        ]);
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("batches Promise.all approvals, runs approved calls, and throws on denied calls", async () => {
    const sent: string[] = [];
    const sendEmail = tool(
      "send_email",
      defineTool({
        approval: always(),
        description: "Send one email.",
        execute: async ({ to }: { to: string }) => {
          sent.push(to);
          return { sent: to };
        },
        inputSchema: {
          properties: { to: { type: "string" } },
          required: ["to"],
          type: "object",
        },
      }),
    );

    await withProgramSession(
      {
        js: `
          const outcomes = await Promise.allSettled(
            ["alice@example.com", "bob@example.com"].map((to) => tools.send_email({ to })),
          );
          return outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : outcome.reason.message);
        `,
        tools: [sendEmail],
      },
      async ({ alice, results, runtime }) => {
        const asked = await (await alice.send("Email both leads.", { auth: null })).result();
        expect(asked.interactions.map((interaction) => interaction.call?.callId).sort()).toEqual([
          "call-program/1",
          "call-program/2",
        ]);
        expect(sent).toEqual([]);

        const answers = asked.interactions.map((interaction) => ({
          interactionId: interaction.interactionId,
          optionId:
            (interaction.call?.input as { to?: string } | undefined)?.to === "alice@example.com"
              ? "approve"
              : "deny",
        }));
        const answered = await (await alice.deliver({ answers }, { auth: null })).result();

        expect(answered.reply).toBe("Done.");
        expect(sent).toEqual(["alice@example.com"]);
        expect(results).toEqual([
          {
            calls: { completed: 1, rejected: 1 },
            notCompleted: [
              { input: '{"to":"bob@example.com"}', outcome: "rejected", tool: "send_email" },
            ],
            result: [{ sent: "alice@example.com" }, expect.any(String)],
          },
        ]);
        expect(await violations(runtime, asked.sessionId)).toEqual([]);
      },
    );
  });

  it("awaits workflow tools and agent fan-out (including ctx.agent alias) and enforces outputSchema", async () => {
    await withProgramSession(
      {
        js: `
          const outputSchema = {
            type: "object",
            properties: { status: { type: "string" }, topic: { type: "string" } },
            required: ["status", "topic"],
          };
          const [deployed, refunds, invoices] = await Promise.all([
            tools.deploy_service({ service: "api" }),
            tools.agent({ message: "Summarize refunds" }),
            ctx.agent("agent", { message: "Summarize invoices", outputSchema }),
          ]);
          let invalid = "";
          try {
            await tools.count_rows({});
          } catch (error) {
            invalid = error.message;
          }
          return { deployed: deployed.plan, invalid, invoices, refunds };
        `,
        tools: [
          tool("agent", agentTool),
          tool(
            "deploy_service",
            defineWorkflowTool({
              description: "Deploy one service.",
              execute: deployServiceWorkflow,
              inputSchema: { properties: { service: { type: "string" } }, type: "object" },
            }),
          ),
          tool(
            "count_rows",
            defineTool({
              description: "Count rows.",
              execute: async () => ({ rows: "many" }),
              inputSchema: {},
              outputSchema: {
                properties: { rows: { type: "number" } },
                required: ["rows"],
                type: "object",
              },
            }),
          ),
        ],
        workflows: [deployServiceBody()],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Deploy and summarize.", { auth: null });
        const result = await delivery.result();
        const events = await recorded(runtime, delivery.sessionId);

        expect(result.reply).toBe("Done.");
        expect(results).toEqual([
          {
            calls: { completed: 4 },
            result: {
              deployed: "plan:api",
              invalid: expect.stringContaining("InvalidToolOutput"),
              invoices: { status: "current", topic: "invoices" },
              refunds: "refunds are current.",
            },
          },
        ]);
        expect(
          eventData(events, "child.opened")
            .map(({ owner }) => owner)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual([{ callId: "call-program/2" }, { callId: "call-program/3" }]);
        expect(eventData(events, "task.started")).toEqual([]);
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("enforces maxSubagents, call limits, and rejects nested workflow() calls", async () => {
    await withProgramSession(
      {
        js: `
          const errors = [];
          for (const name of ["missing_tool", "eve__search", "bg_workflow", "workflow"]) {
            try { await tools[name]({}); } catch (error) { errors.push(error.message); }
          }
          const first = await tools.agent({ message: "Summarize billing" });
          try {
            await tools.agent({ message: "Summarize shipping" });
          } catch (error) {
            errors.push(error.message);
          }
          for (let made = 6; made < 1024; made += 1) await search({ query: "orders" });
          try { await tools.ping({}); } catch (error) { errors.push(error.message); }
          return { errors, first };
        `,
        maxSubagents: 1,
        tools: [
          tool("agent", agentTool),
          tool("bg_workflow", workflow({ maxSubagents: 2 })),
          tool(
            "ping",
            defineTool({
              description: "Ping.",
              execute: async () => "pong",
              inputSchema: {},
            }),
          ),
        ],
      },
      async ({ alice, results }) => {
        await (await alice.send("Check limits.", { auth: null })).result();

        expect(results).toEqual([
          {
            calls: { completed: 1 },
            result: {
              errors: [
                'No tool named "missing_tool". Find tools with search({ query }).',
                '"eve__search" can\'t be called from a program; use search({ query }).',
                '"bg_workflow" runs a workflow program, which a program can\'t nest. Call tools or agents directly from this program, or call "bg_workflow" directly.',
                '"workflow" runs a workflow program, which a program can\'t nest. Call tools or agents directly from this program, or call "workflow" directly.',
                'EXECUTE_AGENT_LIMIT_REACHED: a program may call agents at most 1 times; "agent" was not called.',
                'EXECUTE_CALL_LIMIT_REACHED: a program may make at most 1024 calls; "ping" was not called.',
              ],
              first: "billing are current.",
            },
          },
        ]);
      },
    );
  });

  it("stops a parked program when a steering message arrives", async () => {
    const sent: string[] = [];
    await withProgramSession(
      {
        js: `await tools.send_email({ to: "alice@example.com" }); return "sent";`,
        tools: [
          tool(
            "send_email",
            defineTool({
              approval: always(),
              description: "Send one email.",
              execute: async ({ to }: { to: string }) => {
                sent.push(to);
                return { sent: to };
              },
              inputSchema: {
                properties: { to: { type: "string" } },
                required: ["to"],
                type: "object",
              },
            }),
          ),
        ],
      },
      async ({ alice, results, runtime }) => {
        const asked = await (await alice.send("Email Alice.", { auth: null })).result();
        expect(asked.interactions).toHaveLength(1);

        const steered = await (await alice.send("Never mind.", { auth: null })).result();

        expect(steered.reply).toBe("Done.");
        expect(sent).toEqual([]);
        expect(results).toEqual([
          {
            calls: { rejected: 1 },
            error: "Stopped early because a new message arrived.",
            notCompleted: [
              { input: '{"to":"alice@example.com"}', outcome: "rejected", tool: "send_email" },
            ],
          },
        ]);
        expect(await violations(runtime, asked.sessionId)).toEqual([]);
      },
    );
  });

  it("enforces agent-wide approval policies on search() inside programs", async () => {
    const deferredTool = tool(
      "secret_lookup",
      defineTool({
        deferred: true,
        description: "Inspect restricted internal records.",
        execute: () => ({ secret: true }),
        inputSchema: { type: "object" },
      }),
    );

    await withProgramSession(
      {
        approval: ({ toolName }) =>
          toolName === "eve__search"
            ? { reason: "Discovery blocked.", type: "denied" }
            : "approved",
        js: `
          try {
            return await search({ query: "secret" });
          } catch (error) {
            return { blocked: error.message };
          }
        `,
        tools: [deferredTool],
      },
      async ({ alice, results, runtime }) => {
        const turn = await (await alice.send("Search.", { auth: null })).result();
        expect(turn.reply).toBe("Done.");
        expect(results).toEqual([
          {
            calls: { rejected: 1 },
            notCompleted: [
              { input: '{"query":"secret"}', outcome: "rejected", tool: "eve__search" },
            ],
            result: { blocked: "Discovery blocked." },
          },
        ]);
        expect(await violations(runtime, turn.sessionId)).toEqual([]);
      },
    );

    await withProgramSession(
      {
        approval: ({ toolName }) => (toolName === "eve__search" ? "user-approval" : "approved"),
        js: `return (await search({ query: "secret" })).results.map((entry) => entry.tool);`,
        tools: [deferredTool],
      },
      async ({ alice, results, runtime }) => {
        const paused = await (await alice.send("Search with approval.", { auth: null })).result();
        expect(paused.interactions).toHaveLength(1);
        expect(paused.interactions[0]!.request.kind).toBe("approval");

        const finished = await (
          await alice.deliver(
            {
              answers: [
                { interactionId: paused.interactions[0]!.interactionId, optionId: "approve" },
              ],
            },
            { auth: null },
          )
        ).result();
        expect(finished.reply).toBe("Done.");
        expect(results).toEqual([{ calls: { completed: 1 }, result: ["secret_lookup"] }]);
        expect(await violations(runtime, paused.sessionId)).toEqual([]);
      },
    );
  });

  it("validates connection outputSchema (throwing InvalidToolOutput on mismatch and passing through OpenAPI non-2xx)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/ok")) {
          return new Response(JSON.stringify({ id: "not-a-number" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }
        if (url.endsWith("/empty")) {
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ error: "missing" }), {
          headers: { "content-type": "application/json" },
          status: 404,
        });
      }),
    );

    const apiConnection = moduleEntry(
      "connections/petstore.ts",
      defineOpenAPIConnection({
        baseUrl: "https://petstore.example",
        description: "Petstore API.",
        spec: {
          openapi: "3.0.3",
          info: { title: "Petstore", version: "1.0.0" },
          paths: {
            "/ok": {
              get: {
                operationId: "getPet",
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          properties: { id: { type: "integer" } },
                          required: ["id"],
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/empty": {
              get: {
                operationId: "deletePet",
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          properties: { id: { type: "integer" } },
                          required: ["id"],
                          type: "object",
                        },
                      },
                    },
                  },
                  "204": { description: "No content" },
                },
              },
            },
            "/missing": {
              get: {
                operationId: "getMissing",
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          properties: { id: { type: "integer" } },
                          required: ["id"],
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await withProgramSession(
      {
        js: `
          let invalid = null;
          try {
            await tools.petstore__getPet({});
          } catch (error) {
            invalid = error.message;
          }
          const empty = await tools.petstore__deletePet({});
          const missing = await tools.petstore__getMissing({});
          return { invalid, emptyStatus: empty.status, emptyBody: empty.body, missingStatus: missing.status, missingBody: missing.body };
        `,
        modules: [apiConnection],
        tools: [],
      },
      async ({ alice, results, runtime }) => {
        const turn = await (await alice.send("Check petstore.", { auth: null })).result();
        expect(turn.reply).toBe("Done.");
        expect(results).toEqual([
          {
            calls: { completed: 3 },
            result: {
              emptyBody: null,
              emptyStatus: 204,
              invalid: expect.stringContaining("InvalidToolOutput"),
              missingBody: { error: "missing" },
              missingStatus: 404,
            },
          },
        ]);
        expect(await violations(runtime, turn.sessionId)).toEqual([]);
      },
    );
  });
});
