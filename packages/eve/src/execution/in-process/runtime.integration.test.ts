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
import type { DeliveryTiming } from "#execution/in-process/inbox-transport.js";
import type { InProcessRuntime } from "#execution/in-process/runtime.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
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
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
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
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
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
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
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

  it("joins the session that won a race for an address, as Workflow does", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-race" } });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
      const race = async (runtime: Runtime, token: string) => {
        const created = await Promise.all([
          address(runtime, `${token}-create`).create({ auth: null }),
          address(runtime, `${token}-create`).create({ auth: null }),
        ]);
        const sent = await Promise.all([
          address(runtime, `${token}-send`).send("Alice asks.", { auth: null }),
          address(runtime, `${token}-send`).send("Bob asks.", { auth: null }),
        ]);
        await Promise.all(sent.map((delivery) => delivery.result()));
        return {
          created: created.map((start) => start.created).sort(),
          createdSessions: new Set(created.map((start) => start.session.id)).size,
          sentSessions: new Set(sent.map((delivery) => delivery.sessionId)).size,
        };
      };
      try {
        const here = await race(inProcess, "race-in-process");
        const deployed = await race(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "race-workflow",
        );
        expect(here).toEqual({ created: [false, true], createdSessions: 1, sentSessions: 1 });
        expect(here).toEqual(deployed);
      } finally {
        await inProcess.dispose();
      }
    });
  });

  it("starts the next session for a message sent after an end, as Workflow does", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-end" } });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
      const run = async (runtime: Runtime, token: string) => {
        const alice = address(runtime, token);
        const first = await (await alice.send("Alice asks.", { auth: null })).result();
        await runtime.dispatchSession({
          command: { deliveryId: `${token}-end`, kind: "reset" },
          sessionId: first.sessionId,
        });
        const next = await (await alice.send("Alice asks again.", { auth: null })).result();
        return { nextIsNew: next.sessionId !== first.sessionId, status: next.status };
      };
      try {
        const here = await run(inProcess, "end-in-process");
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "end-workflow",
        );
        expect(here).toEqual({ nextIsNew: true, status: "completed" });
        expect(here).toEqual(deployed);
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
      const inProcess = createTestInProcessRuntime({ compiledArtifactsSource });
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

  it("ends its sessions when disposed", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-dispose" } });
    await test.run(async () => {
      const runtime = createTestInProcessRuntime({
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

  it("ends a session whose turn is still running when disposed", async () => {
    let started!: () => void;
    const modelCalled = new Promise<void>((resolve) => (started = resolve));
    // Answers only once its call is aborted, as a model call still streaming does.
    const waiting = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          started();
          await new Promise((resolve) => abortSignal?.addEventListener("abort", resolve));
          throw abortSignal?.reason;
        },
        modelId: "in-process-waiting",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: waiting, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-dispose-running",
      },
    });
    await test.run(async () => {
      const runtime = createTestInProcessRuntime(
        { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
        { disposeGraceMs: 50 },
      );
      const sent = await address(runtime, "alice-dispose-running").send("Alice says hello.", {
        auth: null,
      });
      const reader = (await runtime.getEventStream(sent.sessionId)).getReader();
      const following = (async () => {
        const events: SessionStreamEvent[] = [];
        for (let next = await reader.read(); !next.done; next = await reader.read())
          events.push(next.value);
        return events;
      })();
      await modelCalled;
      await runtime.dispose();

      const events = await following;
      expect(events.filter(({ type }) => type === "turn.settled")).toMatchObject([
        { data: { outcome: "cancelled" } },
      ]);
      expect(events.filter(({ type }) => type === "session.ended")).toHaveLength(1);
    });
  });

  it("finds no session for a command to one it never ran", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-durable" } });
    await test.run(async () => {
      const runtime = createTestInProcessRuntime({
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

const LATER_MESSAGE = "Carol wants the review by Friday.";

// Spends the whole budget on its first call, a tool call, so the next asks to go on.
const budgetModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const said = (text: string) =>
        prompt.some(
          (message) =>
            message.role === "user" &&
            message.content.some((part) => part.type === "text" && part.text.includes(text)),
        );
      if (said(LATER_MESSAGE)) return textStreamResult("Noted: the review is due Friday.");
      return prompt.some((message) => message.role === "tool")
        ? textStreamResult("Bob's notes are in.")
        : toolCallsStreamResult([
            { input: "{}", toolCallId: "call-notes", toolName: "look_up_notes" },
          ]);
    },
    modelId: "in-process-budget",
    provider: "eve-test",
  }),
);

/** The first event `matches` accepts, read as the session writes it. */
async function firstEvent(
  runtime: Runtime,
  sessionId: string,
  matches: (event: SessionStreamEvent) => boolean,
  timeoutMs: number,
): Promise<SessionStreamEvent | undefined> {
  const reader = (await runtime.getEventStream(sessionId)).getReader();
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read())
      if (matches(next.value)) return next.value;
    return undefined;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

/**
 * Alice runs out of budget, then types a message and "approve" the moment the step that asked
 * ends, before the session reads its end: what Workflow's late replay allows. Returns how the
 * budget prompt settled, or `undefined` if it never did.
 */
async function answerBudgetPromptBackToBack(deliveries: DeliveryTiming, settleWithinMs: number) {
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
        model: defineDynamic(() => ({ model: budgetModel, modelContextWindowTokens: 200_000 })),
      }),
      name: `in-process-budget-${deliveries}`,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Look up notes.",
            execute: async () => ({ notes: "Ship on Friday." }),
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/look_up_notes.ts",
      },
    ],
  });
  return await test.run(async () => {
    const runtime: InProcessRuntime = createTestInProcessRuntime(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      { deliveries },
    );
    try {
      const alice = address(runtime, `alice-budget-${deliveries}`);
      const { sessionId } = await alice.send("Use look_up_notes to find Bob's notes.", {
        auth: null,
      });
      const asked = await firstEvent(
        runtime,
        sessionId,
        (event) => event.type === "interaction.opened" && event.data.request.kind === "budget",
        10_000,
      );
      expect(asked, "the budget prompt").toBeDefined();
      while (runtime.stepsRunning(sessionId) > 0)
        await new Promise((resolve) => setImmediate(resolve));
      await alice.send(LATER_MESSAGE, { auth: null });
      await alice.send("approve", { auth: null });
      const settled = await firstEvent(
        runtime,
        sessionId,
        (event) => event.type === "interaction.settled",
        settleWithinMs,
      );
      return settled?.type === "interaction.settled" ? settled.data.outcome : undefined;
    } finally {
      await runtime.dispose();
    }
  });
}

describe("deliveries made back to back", () => {
  it("are read one at a time when handed over at once", async () => {
    await expect(answerBudgetPromptBackToBack("immediate", 10_000)).resolves.toBe("accepted");
  });

  // Broken until vercel/eve#6307 lands: the message and "approve" are read as one input,
  // "Carol wants…\n\napprove", which names no option, so the prompt never settles. With the fix,
  // expect "accepted", as above.
  it("are read together with the step's end when batched, as on Workflow", async () => {
    // A prompt settles within milliseconds of its answer, so one that hasn't in a second won't.
    await expect(answerBudgetPromptBackToBack("batched", 1_000)).resolves.toBeUndefined();
  });
});
