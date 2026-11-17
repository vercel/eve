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
import { stampedWorkflowBody } from "#internal/testing/stamped-workflow-body.js";
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

/** What the model does once it reads that its program moved to the background. */
type AfterReceipt = "reply" | "wait" | "cancel" | "lookup";

/**
 * A model that runs `code` as one program, then replies with the JSON it read back. Each
 * result it reads is kept in `results`, and each prompt in `prompts`. When
 * the program moves to the background, the model does `afterReceipt` once.
 */
function programModel(
  code: string,
  results: ProgramResults,
  prompts: string[],
  afterReceipt: AfterReceipt,
) {
  let handled = false;
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
        prompts.push(JSON.stringify(prompt));
        // One program per session: every later call reads its result and replies.
        if (results.length === 0) {
          const output = read.at(-1)!;
          results.push("value" in output ? output.value : output);
        }
        const taskId = /as task (program-\w+)/u.exec(JSON.stringify(read))?.[1];
        if (taskId !== undefined && afterReceipt !== "reply" && !handled) {
          handled = true;
          return toolCallsStreamResult([
            afterReceipt === "lookup"
              ? { input: '{"id":"a"}', toolCallId: "call-lookup", toolName: "lookup_order" }
              : afterReceipt === "wait"
                ? { input: "{}", toolCallId: "call-wait", toolName: "eve__task_wait" }
                : {
                    input: JSON.stringify({ taskId }),
                    toolCallId: "call-cancel",
                    toolName: "eve__task_cancel",
                  },
          ]);
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
    /** What the model does once its program moves to the background. Defaults to a reply. */
    readonly afterReceipt?: AfterReceipt;
    /** The agent-wide approval policy, when the session has one. */
    readonly approval?: Parameters<typeof defineAgent>[0]["approval"];
    readonly code: string;
    readonly tools: readonly ReturnType<typeof tool>[];
    /** The plain bodies of the session's `"use workflow"` tools, which the in-process host runs. */
    readonly workflows?: readonly WorkflowBody[];
  },
  run: (session: {
    readonly alice: ReturnType<typeof address>;
    /** Each prompt the model read, as JSON. */
    readonly prompts: readonly string[];
    readonly results: ProgramResults;
    readonly runtime: Runtime;
  }) => Promise<T>,
): Promise<T> {
  const results: ProgramResults = [];
  const prompts: string[] = [];
  const model = programModel(input.code, results, prompts, input.afterReceipt ?? "reply");
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        ...(input.approval !== undefined && { approval: input.approval }),
        codeMode: true,
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
      return await run({ alice: address(runtime, "alice-program"), prompts, results, runtime });
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

  it("counts every agent call toward the agent limit, and refuses the call past it", async () => {
    await withProgramSession(
      {
        // Denied calls count without opening 128 sessions.
        approval: ({ toolName }) => (toolName === "agent" ? "denied" : undefined),
        code: `
          let denied = 0;
          for (let made = 0; made < 128; made += 1) {
            try { await tools.agent({ message: "Review refunds" }); } catch { denied += 1; }
          }
          try { await tools.agent({ message: "Review refunds" }); } catch (error) {
            return { denied, refused: error.message };
          }
        `,
        tools: [tool("agent", agentTool)],
      },
      async ({ alice, results, runtime }) => {
        const delivery = await alice.send("Check billing.", { auth: null });
        await delivery.result();

        // The result also lists each rejected call under `notCompleted`.
        expect(results).toMatchObject([
          {
            calls: { rejected: 128 },
            result: {
              denied: 128,
              refused:
                'EXECUTE_AGENT_LIMIT_REACHED: a program may call agents at most 128 times; "agent" was not called.',
            },
          },
        ]);
        expect(calls(await recorded(runtime, delivery.sessionId), "child.opened")).toEqual([]);
      },
    );
  });

  it("moves a program that waits on approval to the background when a new message arrives", async () => {
    const sent: string[] = [];
    await withProgramSession(
      {
        code: `
          try { await tools.send_email({ to: "alice@example.com" }); return "sent"; }
          catch (error) { return "not sent"; }
        `,
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
      async ({ alice, prompts, results, runtime }) => {
        const asked = await (await alice.send("Email Alice.", { auth: null })).result();
        expect(asked.interactions).toHaveLength(1);

        const steered = await (
          await alice.send("Is the weekly report out?", { auth: null })
        ).result();
        const events = await recorded(runtime, asked.sessionId);

        expect(steered.reply).toBe("Done.");
        // The message withdrew the approval, as it does for a model's own call; nothing was sent.
        expect(sent).toEqual([]);
        // The call the model made is answered with the task's receipt, not a stopped program.
        const [task] = calls(events, "task.started");
        expect(task).toMatchObject({ name: "eve__execute", startedBy: { callId: "call-program" } });
        expect(results).toEqual([
          `A new message arrived, so this program keeps running in the background as task ${String(task!.taskId)}. Its result will arrive in a <task_result> message.`,
        ]);
        // The program went on, and its result reached the model as the task's.
        expect(
          calls(events, "call.settled").find(({ callId }) => callId === "call-program"),
        ).toMatchObject({ outcome: "completed", output: { result: "not sent" } });
        expect(calls(events, "task.ended")).toMatchObject([
          { outcome: "completed", taskId: task!.taskId },
        ]);
        expect(prompts.some((prompt) => prompt.includes("not sent"))).toBe(true);
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

  describe("in the background", () => {
    /**
     * A deploy that waits for `release`, so the program's call is still running when Alice
     * writes. `runs` counts the times it started, and `stopped` the runs told to stop.
     */
    function heldDeploy() {
      const release = Promise.withResolvers<void>();
      const seen = { runs: 0, stopped: 0 };
      return {
        body: stampedWorkflowBody(deployServiceWorkflow, async (input, ctx) => {
          seen.runs += 1;
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) =>
              ctx.abortSignal.addEventListener("abort", () => {
                seen.stopped += 1;
                resolve();
              }),
            ),
          ]);
          return { callId: ctx.callId, plan: `plan:${input.service}`, sessionId: ctx.session.id };
        }),
        release: () => release.resolve(),
        seen,
        tool: tool(
          "deploy_service",
          defineWorkflowTool({
            description: "Deploy one service.",
            execute: deployServiceWorkflow,
            inputSchema: { properties: { service: { type: "string" } }, type: "object" },
          }),
        ),
      };
    }

    /** The session's events once `done` holds for them. */
    async function eventually(
      runtime: Runtime,
      sessionId: string,
      done: (events: readonly SessionStreamEvent[]) => boolean,
    ): Promise<SessionStreamEvent[]> {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const events = await recorded(runtime, sessionId);
        if (done(events)) return events;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const seen = (await recorded(runtime, sessionId)).map((event) => event.type);
      throw new Error(
        `The session never reached the expected events. It published: ${seen.join(" ")}`,
      );
    }

    const has = (events: readonly SessionStreamEvent[], type: string, callId: string) =>
      calls(events, type).some((data) => data.callId === callId);
    const code = `const deployed = await tools.deploy_service({ service: "api" }); return deployed.plan;`;

    it("answers a new message while the program's call still runs, then delivers its result", async () => {
      const deploy = heldDeploy();
      await withProgramSession(
        { code, tools: [deploy.tool], workflows: [deploy.body] },
        async ({ alice, prompts, runtime }) => {
          const first = await alice.send("Deploy the API.", { auth: null });
          await eventually(runtime, first.sessionId, (events) =>
            has(events, "call.started", "call-program/1"),
          );

          const second = await alice.send("Is the weekly report out?", { auth: null });
          // The model answers the message while the deploy is still running.
          const answered = await eventually(
            runtime,
            first.sessionId,
            (events) =>
              calls(events, "task.started").length === 1 &&
              calls(events, "content.completed").some((data) => data.value === "Done."),
          );
          expect(has(answered, "call.settled", "call-program/1")).toBe(false);
          expect(has(answered, "call.settled", "call-program")).toBe(false);

          deploy.release();
          const result = await second.result();
          const events = await recorded(runtime, first.sessionId);

          expect(result.reply).toBe("Done.");
          expect(
            calls(events, "call.settled").find(({ callId }) => callId === "call-program"),
          ).toMatchObject({
            outcome: "completed",
            output: { calls: { completed: 1 }, result: "plan:api" },
          });
          expect(calls(events, "task.ended")).toMatchObject([{ outcome: "completed" }]);
          // The deploy ran once: the wait that followed the message didn't start it again.
          expect(deploy.seen).toEqual({ runs: 1, stopped: 0 });
          expect(
            calls(events, "call.started").filter(({ callId }) => callId === "call-program/1"),
          ).toHaveLength(1);
          // The turn ended only after the program's result reached the model.
          expect(prompts.at(-1)).toContain("plan:api");
          expect(calls(events, "turn.settled")).toHaveLength(1);
          expect(await violations(runtime, first.sessionId)).toEqual([]);
        },
      );
    });

    it("resumes the program while the model waits on its task", async () => {
      const deploy = heldDeploy();
      await withProgramSession(
        { afterReceipt: "wait", code, tools: [deploy.tool], workflows: [deploy.body] },
        async ({ alice, prompts, runtime }) => {
          const first = await alice.send("Deploy the API.", { auth: null });
          await eventually(runtime, first.sessionId, (events) =>
            has(events, "call.started", "call-program/1"),
          );
          const second = await alice.send("Tell me when it is done.", { auth: null });
          await eventually(runtime, first.sessionId, (events) =>
            has(events, "call.requested", "call-wait"),
          );

          deploy.release();
          const result = await second.result();
          const events = await recorded(runtime, first.sessionId);

          expect(result.reply).toBe("Done.");
          expect(has(events, "call.settled", "call-wait")).toBe(true);
          expect(calls(events, "task.ended")).toMatchObject([{ outcome: "completed" }]);
          expect(prompts.some((prompt) => prompt.includes("plan:api"))).toBe(true);
          expect(await violations(runtime, first.sessionId)).toEqual([]);
        },
      );
    });

    it.each(["reply", "wait"] as const)(
      "asks for an approval a background program needs, and resumes it with the answer, when the model's next move is to %s",
      async (afterReceipt) => {
        const deploy = heldDeploy();
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
            afterReceipt,
            code: `
            const deployed = await tools.deploy_service({ service: "api" });
            const mailed = await tools.send_email({ to: "alice@example.com" });
            return [deployed.plan, mailed.sent];
          `,
            tools: [deploy.tool, sendEmail],
            workflows: [deploy.body],
          },
          async ({ alice, runtime }) => {
            const first = await alice.send("Deploy the API, then tell Alice.", { auth: null });
            await eventually(runtime, first.sessionId, (events) =>
              has(events, "call.started", "call-program/1"),
            );
            const second = await alice.send("Is the weekly report out?", { auth: null });
            await eventually(
              runtime,
              first.sessionId,
              (events) => calls(events, "task.started").length === 1,
            );

            deploy.release();
            // The program's next call needs Alice, so the turn pauses on her as it would for a call
            // the model made.
            const asked = await second.result();
            expect(asked.interactions.map((interaction) => interaction.call?.callId)).toEqual([
              "call-program/2",
            ]);
            expect(sent).toEqual([]);

            const answers = asked.interactions.map((interaction) => ({
              interactionId: interaction.interactionId,
              optionId: "approve",
            }));
            const answered = await (await alice.deliver({ answers }, { auth: null })).result();
            const events = await recorded(runtime, first.sessionId);

            expect(answered.reply).toBe("Done.");
            expect(sent).toEqual(["alice@example.com"]);
            expect(
              calls(events, "call.settled").find(({ callId }) => callId === "call-program"),
            ).toMatchObject({
              outcome: "completed",
              output: { calls: { completed: 2 }, result: ["plan:api", "alice@example.com"] },
            });
            expect(await violations(runtime, first.sessionId)).toEqual([]);
          },
        );
      },
    );

    it("ends a background program with the turn when Alice cancels the turn", async () => {
      const deploy = heldDeploy();
      await withProgramSession(
        { code, tools: [deploy.tool], workflows: [deploy.body] },
        async ({ alice, runtime }) => {
          const first = await alice.send("Deploy the API.", { auth: null });
          await eventually(runtime, first.sessionId, (events) =>
            has(events, "call.started", "call-program/1"),
          );
          const second = await alice.send("Is the weekly report out?", { auth: null });
          await eventually(
            runtime,
            first.sessionId,
            (events) =>
              calls(events, "task.started").length === 1 &&
              calls(events, "content.completed").some((data) => data.value === "Done."),
          );

          await alice.cancel();
          await second.result();
          const events = await eventually(
            runtime,
            first.sessionId,
            (seen) => calls(seen, "task.ended").length === 1,
          );

          expect(calls(events, "turn.settled")).toMatchObject([{ outcome: "cancelled" }]);
          expect(calls(events, "task.ended")).toMatchObject([{ outcome: "cancelled" }]);
          expect(has(events, "call.settled", "call-program")).toBe(true);
          expect(has(events, "call.settled", "call-program/1")).toBe(true);
          expect(await violations(runtime, first.sessionId)).toEqual([]);
        },
      );
    });

    it("lets the model finish what it started for the message before the program's next step", async () => {
      const ran: string[] = [];
      await withProgramSession(
        {
          afterReceipt: "lookup",
          code: `
            try { await tools.send_email({ to: "alice@example.com" }); return "sent"; }
            catch (error) { return "not sent"; }
          `,
          tools: [
            lookupOrder(ran),
            tool(
              "send_email",
              defineTool({
                approval: always(),
                description: "Send one email.",
                execute: async ({ to }: { to: string }) => ({ sent: to }),
                inputSchema: {
                  type: "object",
                  properties: { to: { type: "string" } },
                  required: ["to"],
                },
              }),
            ),
          ],
        },
        async ({ alice, runtime }) => {
          const asked = await (await alice.send("Email Alice.", { auth: null })).result();
          expect(asked.interactions).toHaveLength(1);

          // The message withdraws the approval, so the program can run at once; the model looks
          // an order up to answer Alice first.
          const steered = await (await alice.send("What is order a?", { auth: null })).result();
          const events = await recorded(runtime, asked.sessionId);
          const at = (type: string, callId: string) =>
            events.findIndex(
              (event) =>
                event.type === type && (event.data as { callId?: string }).callId === callId,
            );

          expect(steered.reply).toBe("Done.");
          expect(ran).toEqual(["a"]);
          // The model read the order and replied before the program's step ended the program.
          const replied = events.findIndex(
            (event, index) =>
              index > at("call.settled", "call-lookup") && event.type === "model.settled",
          );
          expect(replied).toBeGreaterThan(at("call.settled", "call-lookup"));
          expect(at("call.settled", "call-program")).toBeGreaterThan(replied);
          expect(await violations(runtime, asked.sessionId)).toEqual([]);
        },
      );
    });

    it("stops the program and the call it waits on when the model cancels its task", async () => {
      const deploy = heldDeploy();
      await withProgramSession(
        { afterReceipt: "cancel", code, tools: [deploy.tool], workflows: [deploy.body] },
        async ({ alice, runtime }) => {
          const first = await alice.send("Deploy the API.", { auth: null });
          await eventually(runtime, first.sessionId, (events) =>
            has(events, "call.started", "call-program/1"),
          );
          const second = await alice.send("Stop the deploy.", { auth: null });
          const result = await second.result();
          const events = await recorded(runtime, first.sessionId);

          expect(result.reply).toBe("Done.");
          expect(calls(events, "task.ended")).toMatchObject([
            { outcome: "cancelled", reason: "task-cancel" },
          ]);
          expect(
            calls(events, "call.settled").find(({ callId }) => callId === "call-program"),
          ).toMatchObject({ outcome: "interrupted" });
          expect(
            calls(events, "call.settled").find(({ callId }) => callId === "call-program/1"),
          ).toMatchObject({ outcome: "interrupted" });
          // The one deploy the program waited on was told to stop.
          expect(deploy.seen).toEqual({ runs: 1, stopped: 1 });
          expect(await violations(runtime, first.sessionId)).toEqual([]);
        },
      );
    });
  });
});
