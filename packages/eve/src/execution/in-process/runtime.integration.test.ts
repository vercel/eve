import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const address = (runtime: Runtime, continuationToken: string) =>
  createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });

/** What the protocol checker finds in a session's whole stream, read from its first line. */
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

/** Every event a session recorded so far. */
async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

/** A session's events up to its first `delivery.settled` per delivery sent, with ids numbered. */
async function conversation(runtime: Runtime, token: string, messages: readonly string[]) {
  const results = [];
  let sessionId: string | undefined;
  for (const message of messages) {
    const delivery = await address(runtime, token).send(message, { auth: null });
    sessionId = delivery.sessionId;
    results.push(await delivery.result());
  }
  return {
    events: await recorded(runtime, sessionId!),
    results,
    violations: await violations(runtime, sessionId!),
  };
}

/** Types and data with ids, times, and positions taken out: what two hosts must agree on. */
function shape(events: readonly SessionStreamEvent[]) {
  const ids = new Map<string, string>();
  const rename = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/(?:Id|Token)$/.test(key) || key === "id") {
        if (!ids.has(value)) ids.set(value, `<${ids.size}>`);
        return ids.get(value);
      }
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? "<time>" : value;
    }
    if (Array.isArray(value)) return value.map((entry) => rename(entry, key));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([field]) => field !== "meta" && field !== "runtime")
          .map(([field, entry]) => [field, rename(entry, field)]),
      );
    return value;
  };
  return events.map((event) => rename({ data: event.data, type: event.type }));
}

// Calls both tools in one step, then replies with how each came out.
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const results = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [`${part.toolName}:${part.output.type}`] : [],
            )
          : [],
      );
      return results.length > 0
        ? textStreamResult(`Done: ${results.sort().join(", ")}.`)
        : toolCallsStreamResult([
            { input: "{}", toolCallId: "call-deploy", toolName: "deploy_change" },
            { input: "{}", toolCallId: "call-publish", toolName: "publish_change" },
          ]);
    },
    modelId: "in-process-scripted",
    provider: "eve-test",
  }),
);

const approvedTool = (name: string, ran: string[]) => ({
  loadNamespace: async () => ({
    default: defineTool({
      approval: always(),
      description: `Run ${name}.`,
      execute: async () => {
        ran.push(name);
        return { ran: name };
      },
      inputSchema: {},
    }),
  }),
  logicalPath: `tools/${name}.ts`,
});

/** Alice asks for both calls; she approves one and denies the other, then asks again. */
async function approveAndDeny(runtime: Runtime, token: string) {
  const alice = address(runtime, token);
  const asked = await (await alice.send("Deploy and publish.", { auth: null })).result();
  const answers = asked.interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    optionId: interaction.call?.callId === "call-deploy" ? "approve" : "deny",
  }));
  const answered = await (await alice.deliver({ answers }, { auth: null })).result();
  const followUp = await (await alice.send("Thanks, Bob.", { auth: null })).result();
  const events = await recorded(runtime, asked.sessionId);
  return {
    answered,
    asked,
    events,
    followUp,
    violations: await violations(runtime, asked.sessionId),
  };
}

describe("the in-process runtime", () => {
  it("parks, approves one call and denies another, and continues as Workflow does", async () => {
    const ran: string[] = [];
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-approvals",
      },
      modules: [approvedTool("deploy_change", ran), approvedTool("publish_change", ran)],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      try {
        const here = await approveAndDeny(inProcess, "alice-approvals-in-process");
        const ranHere = ran.splice(0);
        const deployed = await approveAndDeny(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-approvals-workflow",
        );

        // Its session ran here: Workflow names its sessions by their runs.
        expect(here.asked.sessionId).toMatch(/^session_/);
        expect(deployed.asked.sessionId).toMatch(/^wrun_/);
        expect(here.asked.interactions).toHaveLength(2);
        expect(ranHere).toEqual(["deploy_change"]);
        expect(ran).toEqual(["deploy_change"]);
        expect(here.answered.reply).toBe(
          "Done: deploy_change:json, publish_change:execution-denied.",
        );
        expect(here.followUp.status).toBe(deployed.followUp.status);
        expect(shape(here.events)).toEqual(shape(deployed.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        await inProcess.dispose();
      }
    });
  });

  it("runs a session's turns as a Workflow session does", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-parity" } });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      try {
        const messages = [
          "Alice asks for the weekly summary.",
          "Bob asks whether the standup moved.",
        ];
        const here = await conversation(inProcess, "alice-in-process", messages);
        const deployed = await conversation(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-workflow",
          messages,
        );

        expect(here.results.map(({ reply, status }) => ({ reply, status }))).toEqual(
          deployed.results.map(({ reply, status }) => ({ reply, status })),
        );
        expect(here.results[1]?.reply).toContain("Bob asks whether the standup moved.");
        expect(shape(here.events)).toEqual(shape(deployed.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        await inProcess.dispose();
      }
    });
  });

  it("compacts and clears a session between turns as Workflow does", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-controls" } });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      const run = async (runtime: Runtime, token: string) => {
        const alice = address(runtime, token);
        const first = await alice.send("Alice asks for the weekly summary.", { auth: null });
        await first.result();
        for (const kind of ["compact", "clear"] as const) {
          const command = await runtime.dispatchSession({
            command: { deliveryId: `${token}-${kind}`, kind },
            sessionId: first.sessionId,
          });
          expect(command).toMatchObject({ status: "accepted" });
          // A control applies between turns; the next message waits behind it.
        }
        const after = await (await alice.send("Bob asks again.", { auth: null })).result();
        return {
          after,
          events: await recorded(runtime, first.sessionId),
          violations: await violations(runtime, first.sessionId),
        };
      };
      try {
        const here = await run(inProcess, "alice-controls-in-process");
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-controls-workflow",
        );
        expect(here.events.map(({ type }) => type)).toContain("context.settled");
        expect(here.after.reply).toBe(deployed.after.reply);
        expect(shape(here.events)).toEqual(shape(deployed.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        await inProcess.dispose();
      }
    });
  });

  it("cancels a turn waiting on approvals as Workflow does", async () => {
    const ran: string[] = [];
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-cancel",
      },
      modules: [approvedTool("deploy_change", ran), approvedTool("publish_change", ran)],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      const run = async (runtime: Runtime, token: string) => {
        const alice = address(runtime, token);
        const asked = await (await alice.send("Deploy and publish.", { auth: null })).result();
        const cancelled = await runtime.dispatchSession({
          command: { deliveryId: `${token}-cancel`, kind: "cancel" },
          sessionId: asked.sessionId,
        });
        const after = await (await alice.send("Bob asks again.", { auth: null })).result();
        return {
          after,
          asked,
          cancelled,
          events: await recorded(runtime, asked.sessionId),
          violations: await violations(runtime, asked.sessionId),
        };
      };
      try {
        const here = await run(inProcess, "alice-cancel-in-process");
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-cancel-workflow",
        );
        expect(here.asked.interactions).toHaveLength(2);
        expect(here.cancelled).toMatchObject({ status: "accepted" });
        expect(ran).toEqual([]);
        expect(here.events.filter(({ type }) => type === "turn.settled")).toMatchObject([
          { data: { outcome: "cancelled" } },
          { data: { outcome: "completed" } },
        ]);
        expect(here.after.reply).toBe(deployed.after.reply);
        expect(shape(here.events)).toEqual(shape(deployed.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        await inProcess.dispose();
      }
    });
  });

  it("fails a call that needs a durable run, saying what it needs", async () => {
    const delegating = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) =>
          prompt.some((message) => message.role === "tool")
            ? textStreamResult("Alice, I couldn't start that.")
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "Summarize Bob's notes." }),
                  toolCallId: "call-agent",
                  toolName: "agent",
                },
              ]),
        modelId: "in-process-delegating",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: delegating, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-durable-runs",
      },
    });
    await test.run(async () => {
      const runtime = createInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      try {
        const result = await (
          await address(runtime, "alice-durable-runs").send("Ask a helper.", { auth: null })
        ).result();
        expect(result).toMatchObject({
          reply: "Alice, I couldn't start that.",
          status: "completed",
        });
        const events = await recorded(runtime, result.sessionId);
        expect(events.filter(({ type }) => type === "call.settled")).toMatchObject([
          {
            data: {
              callId: "call-agent",
              outcome: "failed",
              output:
                "The `agent` tool needs a durable run, which an in-process session doesn't have. Run the agent with `eve dev` or deploy it.",
            },
          },
        ]);
        expect(events.map(({ type }) => type)).not.toContain("task.started");
        await expect(violations(runtime, result.sessionId)).resolves.toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("ends its sessions when disposed", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-dispose" } });
    await test.run(async () => {
      const runtime = createInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const sent = await address(runtime, "alice-dispose").send("Alice says hello.", {
        auth: null,
      });
      await sent.result();
      // Follows the stream until its writer closes it.
      const reader = (await runtime.getEventStream(sent.sessionId)).getReader();
      const following = (async () => {
        const events: SessionStreamEvent[] = [];
        for (let next = await reader.read(); !next.done; next = await reader.read())
          events.push(next.value);
        return events;
      })();
      await runtime.dispose();
      await runtime.settled(sent.sessionId);

      const ended = (await following).filter(({ type }) => type === "session.ended");
      expect(ended).toHaveLength(1);
      // Its stream is no longer read here.
      await expect(runtime.getStreamTailIndex(sent.sessionId)).rejects.toThrow();
    });
  });

  it("finds no session for a command to one it never ran", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-durable" } });
    await test.run(async () => {
      const runtime = createInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      try {
        await expect(
          runtime.dispatchSession({
            command: { deliveryId: "cancel-1", kind: "cancel" },
            sessionId: "session_unknown",
          }),
        ).resolves.toEqual({ status: "no_active_turn" });
      } finally {
        await runtime.dispose();
      }
    });
  });
});
