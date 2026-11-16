import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import {
  deployServiceBody,
  deployServiceWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { defineAgent } from "#public/definitions/agent.js";
import agentTool from "#public/tools/agent.js";
import { workflow } from "#public/tools/workflow.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

// As eve's host does for agents with code mode on.
installWorkflowSandboxRuntime();

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

/** What the model read as the result of each `eve__execute` call, in order. */
type ProgramResults = unknown[];

/**
 * A model that runs `code` as one program, then replies with the JSON it read back. Each
 * result it reads is kept in `results`.
 */
function programModel(code: string, results: ProgramResults) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        // A copy of the agent a program delegates to answers its message: in words, or with the
        // structured value its caller's `outputSchema` asks for.
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
              input: JSON.stringify({ code }),
              toolCallId: "call-program",
              toolName: "eve__execute",
            },
          ]);
        }
        // One program per session: every later call reads its result and replies.
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

function tool(name: string, definition: unknown) {
  return {
    loadNamespace: async () => ({ default: definition }),
    logicalPath: `tools/${name}.ts`,
  };
}

/** Alice's session with code mode on, over `tools`, where the model runs `code`. */
async function withProgramSession<T>(
  input: {
    readonly code: string;
    /** Off for a session whose model starts a `workflow()` program itself. Defaults to on. */
    readonly codeMode?: boolean;
    /** The session's model, in place of one that runs `code` with `eve__execute`. */
    readonly model?: ReturnType<typeof programModel>;
    readonly tools: readonly ReturnType<typeof tool>[];
    /** The plain bodies of the session's `"use workflow"` tools, which the in-process host runs. */
    readonly workflows?: readonly WorkflowBody[];
  },
  run: (session: {
    readonly alice: ReturnType<typeof address>;
    readonly results: ProgramResults;
    readonly runtime: Runtime;
  }) => Promise<T>,
): Promise<T> {
  const results: ProgramResults = [];
  const model = input.model ?? programModel(input.code, results);
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        codeMode: input.codeMode ?? true,
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "program-session",
    },
    modules: [...input.tools],
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

const lookupOrder = (ran: string[]) =>
  tool(
    "lookup_order",
    defineTool({
      description: "Look up one order.",
      execute: async ({ id }: { id: string }) => {
        ran.push(id);
        return { id, total: id.length };
      },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    }),
  );

const calls = (events: readonly SessionStreamEvent[], type: string) =>
  events.flatMap((event) => (event.type === type ? [event.data as Record<string, unknown>] : []));

describe("a program step", () => {
  it("runs a program's calls inside its step and gives the model one value", async () => {
    const ran: string[] = [];
    await withProgramSession(
      {
        code: `
          const orders = await Promise.all(["a", "bbb"].map((id) => tools.lookup_order({ id })));
          console.log("looked up", orders.length);
          return orders.reduce((sum, order) => sum + order.total, 0);
        `,
        tools: [lookupOrder(ran)],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Total the orders.", { auth: null });
        const result = await delivery.result();
        const events = await recorded(runtime, delivery.sessionId);

        expect(result.reply).toBe("Done.");
        expect(ran.sort()).toEqual(["a", "bbb"]);
        expect(results).toEqual([{ calls: { completed: 2 }, logs: ["looked up 2"], result: 4 }]);
        // Each nested call is an ordinary call the `eve__execute` call owns, under a stable id.
        expect(
          calls(events, "call.requested").map(({ callId, capability, owner }) => ({
            callId,
            name: (capability as { name: string }).name,
            owner,
          })),
        ).toEqual([
          { callId: "call-program", name: "eve__execute", owner: { runId: expect.any(String) } },
          { callId: "call-program/1", name: "lookup_order", owner: { callId: "call-program" } },
          { callId: "call-program/2", name: "lookup_order", owner: { callId: "call-program" } },
        ]);
        expect(calls(events, "call.settled").at(-1)).toMatchObject({
          callId: "call-program",
          label: "Ran code, 2 calls",
          outcome: "completed",
        });
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("parks on a call that needs approval and resumes with the person's answers", async () => {
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
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
      }),
    );
    await withProgramSession(
      {
        code: `
          const outcomes = await Promise.allSettled(
            ["alice@example.com", "bob@example.com"].map((to) => tools.send_email({ to })),
          );
          return outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : outcome.reason.message);
        `,
        tools: [sendEmail],
      },
      async ({ alice, results, runtime }) => {
        const asked = await (await alice.send("Email both leads.", { auth: null })).result();
        // Calls started together ask together, each for its own call.
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

  it("waits on a workflow tool's run and gives the program its result", async () => {
    await withProgramSession(
      {
        code: `const deployed = await tools.deploy_service({ service: "api" }); return deployed.plan;`,
        tools: [
          tool(
            "deploy_service",
            defineWorkflowTool({
              description: "Deploy one service.",
              execute: deployServiceWorkflow,
              inputSchema: { properties: { service: { type: "string" } }, type: "object" },
            }),
          ),
        ],
        workflows: [deployServiceBody()],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Deploy the API.", { auth: null });
        const result = await delivery.result();

        expect(result.reply).toBe("Done.");
        expect(results).toEqual([{ calls: { completed: 1 }, result: "plan:api" }]);
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("awaits agents: each call resolves to the agent's reply or structured value, with no task for the model", async () => {
    await withProgramSession(
      {
        code: `
          const outputSchema = {
            type: "object",
            properties: { status: { type: "string" }, topic: { type: "string" } },
            required: ["status", "topic"],
          };
          return await Promise.all([
            tools.agent({ message: "Summarize refunds" }),
            tools.agent({ message: "Summarize invoices", outputSchema }),
          ]);
        `,
        // The built-in `agent` tool: a copy of this agent, which a model's own call starts as a task.
        tools: [tool("agent", agentTool)],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Check billing.", { auth: null });
        const result = await delivery.result();
        const events = await recorded(runtime, delivery.sessionId);

        expect(result.reply).toBe("Done.");
        expect(results).toEqual([
          {
            calls: { completed: 2 },
            result: ["refunds are current.", { status: "current", topic: "invoices" }],
          },
        ]);
        // Each child session belongs to the nested call that opened it, and none is a task.
        expect(
          calls(events, "child.opened")
            .map(({ owner }) => owner)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual([{ callId: "call-program/1" }, { callId: "call-program/2" }]);
        expect(calls(events, "task.started")).toEqual([]);
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("tells a program what it can't call, and stops counting at the call limit", async () => {
    await withProgramSession(
      {
        code: `
          const refused = [];
          for (const name of ["lookup_ordr", "eve__search", "eve__tool"]) {
            try { await tools[name]({}); } catch (error) { refused.push(error.message); }
          }
          for (let made = 3; made < 1024; made += 1) await search({ query: "orders" });
          try { await tools.lookup_order({ id: "a" }); } catch (error) { refused.push(error.message); }
          return refused;
        `,
        tools: [lookupOrder([])],
      },
      async ({ alice, results }) => {
        await (await alice.send("Try the catalog.", { auth: null })).result();

        expect(results).toEqual([
          {
            calls: {},
            result: [
              'No tool named "lookup_ordr". Find tools with search({ query }).',
              '"eve__search" can\'t be called from a program; use search({ query }).',
              '"eve__tool" is in your tool list; call it directly.',
              'EXECUTE_CALL_LIMIT_REACHED: a program may make at most 1024 calls; "lookup_order" was not called.',
            ],
          },
        ]);
      },
    );
  });

  it("stops a parked program when a new message arrives", async () => {
    const sent: string[] = [];
    await withProgramSession(
      {
        code: `await tools.send_email({ to: "alice@example.com" }); return "sent";`,
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
                type: "object",
                properties: { to: { type: "string" } },
                required: ["to"],
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

  it("rejects an output that doesn't match the entry's output schema", async () => {
    await withProgramSession(
      {
        code: `try { return await tools.count_rows({}); } catch (error) { return error.message; }`,
        tools: [
          tool(
            "count_rows",
            defineTool({
              description: "Count rows.",
              execute: async () => ({ rows: "many" }),
              inputSchema: {},
              outputSchema: {
                type: "object",
                properties: { rows: { type: "number" } },
                required: ["rows"],
              },
            }),
          ),
        ],
      },
      async ({ alice, results }) => {
        await (await alice.send("Count the rows.", { auth: null })).result();

        expect(results).toEqual([
          {
            calls: { completed: 1 },
            result: expect.stringMatching(
              /^InvalidToolOutput: "count_rows" returned a value that doesn't match its output schema: /u,
            ),
          },
        ]);
      },
    );
  });
});

/**
 * A model that starts `code` as one `workflow()` program, waits for its task, and replies. Copies
 * of the agent the program delegates to answer in words.
 */
function workflowModel(code: string) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const delegated = /Summarize (\w+)/u.exec(JSON.stringify(prompt.at(-1)))?.[1];
        if (delegated !== undefined) return textStreamResult(`${delegated} are current.`);
        const called = (name: string) => JSON.stringify(prompt).includes(`"toolName":"${name}"`);
        if (!called("workflow")) {
          return toolCallsStreamResult([
            { input: JSON.stringify({ code }), toolCallId: "call-workflow", toolName: "workflow" },
          ]);
        }
        if (!called("eve__task_wait")) {
          return toolCallsStreamResult([
            { input: "{}", toolCallId: "call-wait", toolName: "eve__task_wait" },
          ]);
        }
        return textStreamResult("Done.");
      },
      modelId: "workflow-scripted",
      provider: "eve-test",
    }),
  );
}

describe("a workflow() program", () => {
  it("runs in the background as a task, whose agents answer in sessions its call owns", async () => {
    const code = `
      const [refunds, invoices] = await Promise.all([
        tools.agent({ message: "Summarize refunds" }),
        tools.agent({ message: "Summarize invoices" }),
      ]);
      console.log("summarized 2");
      return { invoices, refunds };
    `;
    await withProgramSession(
      { code, codeMode: false, model: workflowModel(code), tools: [tool("workflow", workflow())] },
      async ({ alice, runtime }) => {
        const delivery = await alice.send("Check billing.", { auth: null });
        const result = await delivery.result();
        const events = await recorded(runtime, delivery.sessionId);

        expect(result.reply).toBe("Done.");
        const [task] = calls(events, "task.started");
        expect(task).toMatchObject({ name: "workflow", startedBy: { callId: "call-workflow" } });
        // Each child session hangs under the `workflow` call, as a program's calls hang under
        // `eve__execute`.
        expect(calls(events, "child.opened").map(({ owner }) => owner)).toEqual([
          { callId: "call-workflow" },
          { callId: "call-workflow" },
        ]);
        // The task's result is the value a program in the turn gives the model.
        expect(
          calls(events, "call.settled").find(({ callId }) => callId === "call-workflow"),
        ).toMatchObject({
          outcome: "completed",
          output: {
            calls: { completed: 2 },
            logs: ["summarized 2"],
            result: { invoices: "invoices are current.", refunds: "refunds are current." },
          },
        });
        expect(await violations(runtime, delivery.sessionId)).toEqual([]);
      },
    );
  });

  it("can't be started from a program, which calls the agents itself", async () => {
    await withProgramSession(
      {
        code: `try { return await tools.workflow({ code: "return 1" }); } catch (error) { return error.message; }`,
        tools: [tool("workflow", workflow()), tool("agent", agentTool)],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Check billing.", { auth: null });
        await delivery.result();

        expect(results).toEqual([
          {
            calls: {},
            result:
              '"workflow" runs a program in the background, which a program can\'t start. Call the agents from this program as tools.<agent>({ message }), or call "workflow" directly.',
          },
        ]);
        expect(calls(await recorded(runtime, delivery.sessionId), "task.started")).toEqual([]);
      },
    );
  });
});
