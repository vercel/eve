import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import {
  address,
  callOf,
  dataField,
  follow,
  parallelShape,
  recorded,
  replies,
  shape,
  violations,
} from "#internal/testing/in-process-sessions.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

// Workflow tool runs in this process: the `agent` tool's subagents, tasks and their waits, a
// cancel that reaches a child, and an authored workflow tool's task. Where Workflow runs the same
// conversation, both hosts must record the same thing.

const textOf = (prompt: unknown) => JSON.stringify(prompt);

/** An agent compiled around `model`, under `name`. */
function agentWith(model: MockLanguageModelV4, name: string) {
  return {
    definition: defineAgent({
      model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
    }),
    name,
  };
}

/**
 * Alice's agent delegates to copies of itself with the `agent` tool. A copy answers its message;
 * the parent says it's waiting, or waits on the tasks, then reports each result.
 */
function delegatingModel(messages: readonly string[], options: { readonly wait?: boolean } = {}) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const text = textOf(prompt);
        const asked = messages.find((message) => text.includes(`Summarize ${message}`));
        if (asked !== undefined && !text.includes("Alice asks"))
          return textStreamResult(`${asked}: ship on Friday.`);
        const results = [...text.matchAll(/<task_result id=/g)].length;
        if (results >= messages.length)
          return textStreamResult(`Alice, the helpers report back (${results}).`);
        const tools = prompt.filter((message) => message.role === "tool").length;
        if (tools > 0)
          return options.wait === true
            ? toolCallsStreamResult([
                { input: "{}", toolCallId: `call-wait-${tools}`, toolName: "eve__task_wait" },
              ])
            : textStreamResult("Waiting on the helpers.");
        return toolCallsStreamResult(
          messages.map((message, index) => ({
            input: JSON.stringify({ message: `Summarize ${message}.` }),
            toolCallId: `call-agent-${index}`,
            toolName: "agent",
          })),
        );
      },
      modelId: "in-process-delegating",
      provider: "eve-test",
    }),
  );
}

/** Alice's request, the same on both hosts: what each recorded, and the checker's verdict. */
async function onBothHosts(model: MockLanguageModelV4, name: string) {
  const test = await createTestRuntime({ agent: agentWith(model, name) });
  return await test.run(async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const inProcess = createInProcessRuntime({ compiledArtifactsSource });
    const run = async (runtime: Runtime, token: string) => {
      const sent = await address(runtime, token).send("Alice asks a helper.", { auth: null });
      await follow(runtime, sent.sessionId, (seen) =>
        seen.some((event) => event.type === "turn.settled"),
      );
      const events = await recorded(runtime, sent.sessionId);
      return {
        events,
        replies: replies(events),
        violations: await violations(runtime, sent.sessionId),
      };
    };
    try {
      const here = await run(inProcess, `${name}-in-process`);
      const deployed = await run(
        createWorkflowRuntime({ compiledArtifactsSource }),
        `${name}-workflow`,
      );
      return { deployed, here };
    } finally {
      await inProcess.dispose();
    }
  });
}

describe("in-process runs", () => {
  it("runs a subagent through the agent tool as Workflow does", async () => {
    const { deployed, here } = await onBothHosts(
      delegatingModel(["Bob's notes"]),
      "in-process-subagent",
    );
    expect(here.replies).toContain("Alice, the helpers report back (1).");
    expect(here.events.map(({ type }) => type)).toContain("task.started");
    expect(here.violations).toEqual([]);
    expect(deployed.violations).toEqual([]);
    expect(shape(here.events)).toEqual(shape(deployed.events));
  }, 60_000);

  it("fans out to three subagents and waits on their tasks as Workflow does", async () => {
    const notes = ["Bob's notes", "Carol's notes", "Dan's notes"];
    const { deployed, here } = await onBothHosts(
      delegatingModel(notes, { wait: true }),
      "in-process-fan-out",
    );
    expect(here.replies).toContain("Alice, the helpers report back (3).");
    const types = here.events.map(({ type }) => type);
    expect(types.filter((type) => type === "task.started")).toHaveLength(3);
    expect(types.filter((type) => type === "child.opened")).toHaveLength(3);
    expect(deployed.replies).toContain("Alice, the helpers report back (3).");
    expect(here.violations).toEqual([]);
    expect(deployed.violations).toEqual([]);
    // Which child finishes when is up to each host, and with it how many waits the parent makes
    // and what each reports. Each subagent's call is the same on both, and across its waits
    // each host reports every task done.
    const agentCalls = (events: readonly SessionStreamEvent[]) =>
      Object.fromEntries(
        Object.entries(parallelShape(events).calls).filter(([callId]) =>
          callId.startsWith("call-agent-"),
        ),
      );
    expect(agentCalls(here.events)).toEqual(agentCalls(deployed.events));
    const tasksDone = (events: readonly SessionStreamEvent[]) =>
      events
        .filter((event) => event.type === "call.settled" && callOf(event)?.startsWith("call-wait"))
        .map((event) => String(dataField(event, "output")))
        .join(" ")
        .split("completed").length - 1;
    expect(tasksDone(here.events)).toBe(3);
    expect(tasksDone(deployed.events)).toBe(3);
  }, 90_000);

  it("cancels a parent's subagent with its turn, as Workflow does", async () => {
    let childStarted: () => void = () => {};
    let started = new Promise<void>((resolve) => (childStarted = resolve));
    // The helper works until its turn is cancelled.
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ abortSignal, prompt }) => {
          const text = textOf(prompt);
          if (text.includes("Summarize Bob's notes") && !text.includes("Alice asks")) {
            childStarted();
            await new Promise<void>((resolve) => {
              if (abortSignal?.aborted) resolve();
              abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return textStreamResult("Too late.");
          }
          return prompt.some((message) => message.role === "tool")
            ? textStreamResult("Waiting on the helper.")
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "Summarize Bob's notes." }),
                  toolCallId: "call-agent-0",
                  toolName: "agent",
                },
              ]);
        },
        modelId: "in-process-cancel",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({ agent: agentWith(model, "in-process-run-cancel") });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      const run = async (runtime: Runtime, token: string, hearsChildLate = false) => {
        started = new Promise<void>((resolve) => (childStarted = resolve));
        const sent = await address(runtime, token).send("Alice asks a helper.", { auth: null });
        await started;
        // Cancelled once the parent's call that says it waits settled, so both hosts cancel at
        // the same point.
        await follow(
          runtime,
          sent.sessionId,
          (seen) => seen.filter((event) => event.type === "model.settled").length === 2,
        );
        // On Workflow the helper's run reports that it opened the helper's session once its start
        // claimed the session's address, which can come after that call: the parent has heard of
        // its helper before it's cancelled, as in this process.
        if (hearsChildLate)
          await follow(runtime, sent.sessionId, (seen) =>
            seen.some((event) => event.type === "child.opened"),
          );
        const cancelled = await runtime.dispatchSession({
          command: { deliveryId: `${token}-cancel`, kind: "cancel" },
          sessionId: sent.sessionId,
        });
        // The cancel's own delivery settles after the turn it cancelled.
        await follow(runtime, sent.sessionId, (seen) =>
          seen.some(
            (event) =>
              event.type === "delivery.settled" &&
              dataField(event, "deliveryId") === `${token}-cancel`,
          ),
        );
        const events = await recorded(runtime, sent.sessionId);
        const opened = events.find((event) => event.type === "child.opened");
        const childId = opened === undefined ? undefined : dataField(opened, "sessionId");
        // The helper's session ends with the run that opened it.
        const childEvents =
          typeof childId === "string"
            ? await follow(runtime, childId, (seen) =>
                seen.some((event) => event.type === "session.ended"),
              )
            : [];
        return {
          cancelled,
          childEvents,
          events,
          violations: await violations(runtime, sent.sessionId),
        };
      };
      try {
        const cancelledTurn = (events: readonly SessionStreamEvent[]) =>
          events.filter(({ type }) => type === "turn.settled");
        const here = await run(inProcess, "alice-run-cancel-in-process");
        expect(here.cancelled).toMatchObject({ status: "accepted" });
        // Here the cancel names itself the turn's cause, though it stopped the turn's wait on its
        // task before the turn admitted it. Workflow doesn't, on this base: the reference's
        // `18cb57608` changes Workflow's turn to name it too, which this stack leaves for later.
        expect(cancelledTurn(here.events)).toMatchObject([
          {
            data: {
              cause: { deliveryId: "alice-run-cancel-in-process-cancel" },
              outcome: "cancelled",
            },
          },
        ]);
        expect(here.childEvents.filter(({ type }) => type === "turn.settled")).toMatchObject([
          { data: { outcome: "cancelled" } },
        ]);
        expect(here.childEvents.at(-1)?.type).toBe("session.ended");
        expect(here.violations).toEqual([]);
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-run-cancel-workflow",
          true,
        );
        expect(deployed.violations).toEqual([]);
        expect(cancelledTurn(deployed.events)).toMatchObject([{ data: { outcome: "cancelled" } }]);
        // The call, its task and the child it opened go the same way on both hosts.
        expect(parallelShape(here.events).calls).toEqual(parallelShape(deployed.events).calls);
        expect(shape(here.childEvents)).toEqual(shape(deployed.childEvents));
      } finally {
        await inProcess.dispose();
      }
    });
  }, 90_000);

  it("runs an authored workflow tool's task in the background, and the turn waits on it", async () => {
    // Alice's build runs as a task: it reports progress, then its result.
    const build = Object.assign(
      async function* (input: { readonly target: string }) {
        yield { progress: `compiling ${input.target}` };
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { built: input.target };
      },
      { workflowId: "workflow//in-process-test//build" },
    );
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const text = textOf(prompt);
          if (text.includes("<task_result id="))
            return textStreamResult("Alice, the build is done.");
          const tools = prompt.filter((message) => message.role === "tool").length;
          return tools > 0
            ? toolCallsStreamResult([
                { input: "{}", toolCallId: `call-wait-${tools}`, toolName: "eve__task_wait" },
              ])
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ target: "web" }),
                  toolCallId: "call-build",
                  toolName: "build",
                },
              ]);
        },
        modelId: "in-process-task",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: agentWith(model, "in-process-task"),
      modules: [
        {
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Build a target.",
              inputSchema: {
                properties: { target: { type: "string" } },
                required: ["target"],
                type: "object",
              },
              task: build,
            }),
          }),
          logicalPath: "tools/build.ts",
        },
      ],
    });
    await test.run(async () => {
      const runtime = createInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      runtime.registerWorkflow(build.workflowId, build);
      try {
        const sent = await address(runtime, "alice-task").send("Alice asks for a build.", {
          auth: null,
        });
        await follow(runtime, sent.sessionId, (seen) =>
          seen.some((event) => event.type === "turn.settled"),
        );
        const events = await recorded(runtime, sent.sessionId);
        expect(events.filter((event) => event.type === "task.started")).toHaveLength(1);
        expect(
          events.filter((event) => event.type === "call.settled").map((event) => event.data),
        ).toContainEqual(
          expect.objectContaining({
            callId: "call-build",
            outcome: "completed",
            output: { built: "web" },
          }),
        );
        expect(replies(events)).toEqual(["Alice, the build is done."]);
        await expect(violations(runtime, sent.sessionId)).resolves.toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });
  }, 60_000);

  it("asks Alice a question with ask_question and goes on with her answer, as Workflow does", async () => {
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const text = textOf(prompt);
          if (text.includes("answered") && text.includes("Friday"))
            return textStreamResult("Alice, we ship on Friday.");
          return toolCallsStreamResult([
            {
              input: JSON.stringify({
                options: [
                  { description: "Before the weekend.", label: "Friday" },
                  { description: "After the weekend.", label: "Monday" },
                ],
                question: "Which day should we ship?",
              }),
              toolCallId: "call-ask",
              toolName: "ask_question",
            },
          ]);
        },
        modelId: "in-process-ask",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: agentWith(model, "in-process-ask"),
      modules: [
        {
          loadNamespace: async () => ({
            default: (await import("#tools/provided/ask-question.js")).askQuestion,
          }),
          logicalPath: "tools/ask_question.ts",
        },
      ],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      const run = async (runtime: Runtime, token: string) => {
        const alice = address(runtime, token);
        const sent = await alice.send("When do we ship?", { auth: null });
        await follow(runtime, sent.sessionId, (seen) =>
          seen.some((event) => event.type === "interaction.opened"),
        );
        await alice.send("Friday", { auth: null });
        await follow(runtime, sent.sessionId, (seen) =>
          replies(seen).includes("Alice, we ship on Friday."),
        );
        await follow(runtime, sent.sessionId, (seen) =>
          seen.some((event) => event.type === "turn.settled"),
        );
        const events = await recorded(runtime, sent.sessionId);
        return { events, violations: await violations(runtime, sent.sessionId) };
      };
      try {
        const here = await run(inProcess, "alice-ask-in-process");
        expect(here.events.map(({ type }) => type)).toContain("interaction.opened");
        expect(
          here.events.filter((event) => event.type === "call.settled").map((event) => event.data),
        ).toMatchObject([
          {
            callId: "call-ask",
            outcome: "completed",
            output: { answer: "Friday", status: "answered" },
          },
        ]);
        expect(replies(here.events)).toEqual(["Alice, we ship on Friday."]);
        expect(here.violations).toEqual([]);
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-ask-workflow",
        );
        expect(deployed.violations).toEqual([]);
        expect(shape(here.events)).toEqual(shape(deployed.events));
      } finally {
        await inProcess.dispose();
      }
    });
  }, 90_000);
});
