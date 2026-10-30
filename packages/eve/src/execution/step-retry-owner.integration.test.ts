import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { AnyEventRequest } from "@workflow/world";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { defineDynamic } from "#dynamic/definition.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { forgetSessionLive } from "#reactions/state.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";

// A turn step that published and then lost its checkpoint runs again from the checkpoint. The
// harness loses each step's completion once, right after the step published the fact named,
// as a process that exits before its checkpoint saves does.

vi.setConfig({ testTimeout: 90_000 });

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

interface Session {
  readonly next: (label: string) => Promise<SessionStreamEvent[]>;
  readonly answer: (interactionId: string, optionId: string) => Promise<void>;
  readonly send: (message: string) => Promise<void>;
  readonly events: () => readonly SessionStreamEvent[];
  readonly interrupted: () => number;
}

async function withInterruptedSession(
  name: string,
  options: {
    readonly tools: readonly {
      readonly name: string;
      readonly approval?: boolean;
      /** Runs as a workflow, whose result the turn waits on. */
      readonly workflow?: true;
    }[];
    /** What the model answers each call, from the prompt it reads. */
    readonly respond: (prompt: string, call: number) => StreamResult;
    /** The step that publishes the `nth` of these facts loses its completion once. */
    readonly interruptAfter?: { readonly type: string; readonly nth?: number };
    /** Which turn-step completions, counted from 1, are lost. */
    readonly loseTurnStep?: (completion: number) => boolean;
    /** How many turn-step attempts, from the first, fail their first session write. */
    readonly failTurnStepWrites?: number;
  },
  body: (session: Session) => Promise<void>,
) {
  const prompts: string[] = [];
  const ran: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (call: LanguageModelV4CallOptions) => {
        const prompt = JSON.stringify(call.prompt);
        prompts.push(prompt);
        return options.respond(prompt, prompts.length);
      },
      modelId: name,
      provider: "eve-test",
    }),
  );
  let seen = 0;
  let armed = false;
  let interrupted = 0;
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              [options.interruptAfter?.type ?? "session.started"]() {
                seen += 1;
                if (
                  options.interruptAfter !== undefined &&
                  seen === (options.interruptAfter.nth ?? 1)
                )
                  armed = true;
              },
            },
          }),
        }),
        logicalPath: "hooks/interrupt.ts",
      },
      ...options.tools.map((tool) => ({
        loadNamespace: async () => ({
          default: tool.workflow
            ? defineWorkflowTool({
                description: `Run ${tool.name} for Alice.`,
                execute: deployServiceWorkflow,
                inputSchema: { properties: { service: { type: "string" } }, type: "object" },
              })
            : defineTool({
                approval: tool.approval === true ? { request: always() } : undefined,
                description: `Run ${tool.name} for Alice.`,
                execute: () => {
                  ran.push(tool.name);
                  return { done: tool.name };
                },
                inputSchema: z.object({}).passthrough(),
              }),
        }),
        logicalPath: `tools/${tool.name}.ts`,
      })),
    ],
  });
  const continuationToken = `http:${name}`;
  const events: SessionStreamEvent[] = [];
  await runtime.run(async () => {
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const create = world.events.create.bind(world.events);
    let sessionId: string | undefined;
    let turnSteps = 0;
    let failingWrites = options.failTurnStepWrites ?? 0;
    let failNextWrite = false;
    const getWriter = WritableStream.prototype.getWriter;
    const writerSpy = vi.spyOn(WritableStream.prototype, "getWriter").mockImplementation(function (
      this: WritableStream<Uint8Array>,
    ) {
      const writer = getWriter.call(this);
      const write = writer.write.bind(writer);
      writer.write = async (chunk) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("The session stream is unavailable");
        }
        return await write(chunk);
      };
      return writer;
    });
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args as [string, AnyEventRequest];
      const turnStep =
        event.eventType === "step_completed" &&
        String((event.eventData as { stepName?: string }).stepName).includes("turnStep");
      const lose = turnStep && options.loseTurnStep?.(++turnSteps) === true;
      if (
        runId === sessionId &&
        event.eventType === "step_started" &&
        String((event.eventData as { stepName?: string }).stepName).includes("turnStep") &&
        failingWrites > 0
      ) {
        failingWrites -= 1;
        failNextWrite = true;
      }
      if ((lose || armed) && runId === sessionId && event.eventType === "step_completed") {
        armed = false;
        interrupted += 1;
        forgetSessionLive(runId);
        throw new Error("Process exited after publication, before checkpoint");
      }
      return await create(...args);
    });
    const run = await startSessionOwner(workflowEntry, [
      {
        input: { message: "Help Alice with her account." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    sessionId = run.runId;
    const commandInbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    try {
      await body({
        async answer(interactionId, optionId) {
          await resumeHook(commandInbox, {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { answers: [{ interactionId, optionId }] },
          });
        },
        events: () => events,
        interrupted: () => interrupted,
        async next(label) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const read = await Promise.race([
            stream.nextTurn(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Timed out waiting for ${label} after: ${events.map((event) => event.type).join(", ")}`,
                    ),
                  ),
                60_000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          events.push(...read);
          return read;
        },
        async send(message) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { message },
          });
        },
      });
    } finally {
      stream.dispose();
      spy.mockRestore();
      writerSpy.mockRestore();
      world.events.createBatch = createBatch;
      await run.cancel().catch(() => {});
    }
  });
  // Every line follows the one before it, and no fact is written twice.
  const lines = [...new Set(events.map(({ meta }) => meta.position.line))];
  expect(lines).toEqual(Array.from({ length: lines.length }, (_, index) => index + lines[0]!));
  const ids = {
    "call.requested": "callId",
    "model.requested": "runId",
    "turn.settled": "turnId",
    "turn.started": "turnId",
  } as const;
  for (const [type, field] of Object.entries(ids)) {
    const written = events
      .filter((event) => event.type === type)
      .map((event) => (event.data as Record<string, unknown>)[field]);
    expect(new Set(written).size, type).toBe(written.length);
  }
  return { prompts, ran, observed: seen };
}

const ofType = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T,
) =>
  events.filter((event): event is Extract<SessionStreamEvent, { type: T }> => event.type === type);

it("keeps a turn that settled before its checkpoint was lost, and the session goes on", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-settled",
    {
      interruptAfter: { type: "turn.settled" },
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
          : textStreamResult(call === 2 ? "Alice's record is ready." : "You're welcome."),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      await session.next("first turn");
      await vi.waitFor(() => expect(session.interrupted()).toBe(1));
      await session.send("Thanks!");
      await session.next("second turn");
    },
  );
  expect(ran).toEqual(["lookup"]);
  expect(prompts).toHaveLength(3);
  // The next turn reads the settled turn's input and reply.
  expect(prompts[2]).toContain("Help Alice with her account.");
  expect(prompts[2]).toContain("Alice's record is ready.");
});

it("runs the model again after an interrupted step, without running its tool again", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-after-tool",
    {
      interruptAfter: { type: "call.settled" },
      respond: (prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
          : textStreamResult(
              prompt.includes("result was lost") ? "I checked: it ran." : "Unexpected prompt.",
            ),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("first turn");
      await vi.waitFor(() => expect(session.interrupted()).toBe(1));
      expect(ofType(turn, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(ran).toEqual(["lookup"]);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("lookup");
});

it("does not run an approved call again when the step that ran it is interrupted", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-approved",
    {
      // The step that runs the approved deploy asks for a notify approval, then loses its
      // checkpoint.
      interruptAfter: { nth: 2, type: "interaction.opened" },
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "deploy", toolName: "deploy" })
          : call <= 3
            ? toolCallStreamResult({ input: "{}", toolCallId: "notify", toolName: "notify" })
            : textStreamResult("Deployed and notified."),
      tools: [
        { approval: true, name: "deploy" },
        { approval: true, name: "notify" },
      ],
    },
    async (session) => {
      await session.next("deploy approval");
      const [deploy] = ofType(session.events(), "interaction.opened");
      await session.answer(deploy!.data.interactionId, "approve");
      await session.next("notify approval");
      await vi.waitFor(() => expect(session.interrupted()).toBe(1));
      // The retry closes the approval its attempt asked for, and the model asks again.
      await session.next("notify approval again");
      const opened = ofType(session.events(), "interaction.opened").map(
        (event) => event.data.interactionId,
      );
      expect(opened).toHaveLength(3);
      expect(
        ofType(session.events(), "interaction.settled").map((event) => [
          event.data.interactionId,
          event.data.outcome,
        ]),
      ).toEqual([
        [opened[0], "accepted"],
        [opened[1], "abandoned"],
      ]);
      await session.answer(opened[2]!, "approve");
      await session.next("reply");
    },
  );
  expect(ran).toEqual(["deploy", "notify"]);
  expect(prompts).toHaveLength(4);
  // The model reads that deploy ran, and doesn't read the applied approval again as new input.
  expect(prompts[2]).toContain("result was lost");
  expect(prompts[2]).not.toContain("earlier interactive prompt");
});

it("hands a workflow's result to the step again when the step that read it is interrupted", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-workflow-result",
    {
      // The step that reads the deploy's result runs lookup, then loses its checkpoint.
      interruptAfter: { nth: 2, type: "call.settled" },
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({
              input: JSON.stringify({ service: "billing" }),
              toolCallId: "deploy",
              toolName: "deploy",
            })
          : call === 2
            ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
            : textStreamResult("Billing is deployed."),
      tools: [{ name: "deploy", workflow: true }, { name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("reply");
      await vi.waitFor(() => expect(session.interrupted()).toBe(1));
      if (ofType(turn, "turn.settled").length === 0) await session.next("reply after retry");
      expect(ofType(session.events(), "turn.settled")).toMatchObject([
        { data: { outcome: "completed" } },
      ]);
    },
  );
  expect(ran).toEqual(["lookup"]);
  expect(prompts).toHaveLength(3);
  // The retry reads the workflow's result, and that lookup may already have run.
  expect(prompts[2]).toContain("plan:billing");
  expect(prompts[2]).toContain("result was lost");
});

it("fails the turn, not the session, when its steps are interrupted too many times", async () => {
  let lastCallId: string | undefined;
  const { ran, prompts } = await withInterruptedSession(
    "retry-too-often",
    {
      // Each of the first turn's steps loses its first completion; its retry completes.
      loseTurnStep: (completion) => completion % 2 === 1 && completion <= 7,
      respond: (prompt, call) =>
        prompt.includes("Try again")
          ? textStreamResult("Done.")
          : // Providers name each call afresh: the turn's lost calls never reach history.
            toolCallStreamResult({
              input: JSON.stringify({ operation: `lookup-${call}` }),
              toolCallId: `lookup-${call}`,
              toolName: "lookup",
            }),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("failed turn");
      expect(ofType(turn, "turn.settled")).toMatchObject([
        { data: { error: { code: "STEP_INTERRUPTED" }, outcome: "failed" } },
      ]);
      lastCallId = ofType(session.events(), "call.started").at(-1)?.data.callId;
      await session.send("Try again, please.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(ran.length).toBeGreaterThan(0);
  expect(lastCallId).toBeDefined();
  expect(prompts.at(-1)).toContain(lastCallId);
});

it("keeps an approved call's recorded outcome in history after retry exhaustion", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-approved-exhausted",
    {
      loseTurnStep: (completion) => completion >= 2 && completion <= 5,
      respond: (prompt, call) =>
        prompt.includes("Check what happened")
          ? textStreamResult("I will check the deployment before continuing.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `${call === 1 ? "deploy" : "notify"}-${call}`,
              toolName: call === 1 ? "deploy" : "notify",
            }),
      tools: [
        { name: "deploy", approval: true },
        { name: "notify", approval: true },
      ],
    },
    async (session) => {
      await session.next("approval");
      const [approval] = ofType(session.events(), "interaction.opened");
      await session.answer(approval!.data.interactionId, "approve");
      for (let attempt = 0; attempt < 6; attempt++) {
        const events = await session.next("approval retry or failed turn");
        if (ofType(events, "turn.settled").length > 0) break;
      }
      // No attempt threw; the workflow's own exhaustion error is the failure.
      expect(ofType(session.events(), "turn.settled")).toMatchObject([
        { data: { error: { code: "FatalError", id: expect.any(String) }, outcome: "failed" } },
      ]);
      await session.send("Check what happened before continuing.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(ran).toEqual(["deploy"]);
  expect(prompts.at(-1)).toContain("This call completed, but its result was lost");
});

it("fails the turn, not the session, when a step fails every attempt", async () => {
  // A failed attempt waits this long for its stream's writes before it retries.
  vi.stubEnv("WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS", "500");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const { observed } = await withInterruptedSession(
    "retry-exhausted",
    {
      // Every attempt of the first step fails to write; the recovery step's write succeeds.
      failTurnStepWrites: 4,
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
          : textStreamResult("Done."),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("failed turn");
      // The turn reports what the last attempt threw, under an id its log line carries.
      expect(ofType(turn, "turn.settled")).toMatchObject([
        {
          data: {
            error: {
              code: "STEP_FAILED",
              id: expect.any(String),
              message: "The session stream is unavailable",
            },
            outcome: "failed",
          },
        },
      ]);
      await session.send("Try again, please.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(observed).toBe(1);
});
