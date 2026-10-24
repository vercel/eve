import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { SessionAuthContext, SessionParent } from "#channel/types.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationOf } from "#client/conversation.js";
import type { EveToolPart } from "#client/message-types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  textStreamResult,
  toolCallsStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { readSessionEventHistory } from "#execution/session-event-stream.js";
import { viewOfEvents } from "#protocol/session-projection/fold.js";
import { failure } from "#protocol/session-projection/selectors.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { z } from "zod";
import {
  defineWorkflowTool,
  type WorkflowExecuteToolDefinition,
} from "#tools/workflow-definition.js";
import { waitingForCleanupWorkflow } from "#internal/testing/workflow-tool-fixtures.js";

// Sessions driven through their odd paths: tools that fail, approvals that are cancelled,
// steered, answered twice or for nothing, models that fail mid-response, and controls that
// arrive while a person is asked. The integration config checks every line each session
// writes against the event contract; each test also folds the whole stream as a reader would
// and checks what a finished turn leaves behind.

// The first session in a file compiles the agent; later ones reuse it.
vi.setConfig({ testTimeout: 90_000 });

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
});

const HEARD_TYPES = [
  "session.started",
  "session.ended",
  "turn.started",
  "turn.settled",
  "call.requested",
  "call.settled",
  "interaction.opened",
  "interaction.settled",
  "model.started",
  "model.retried",
  "model.settled",
] as const;

/** Registers a provider for the agent that records every lifecycle event it hears. */
async function hearInstrumentation(agentName: string): Promise<InstrumentationEvent[]> {
  const heard: InstrumentationEvent[] = [];
  const record = (event: InstrumentationEvent) => void heard.push(event);
  await registerInstrumentationProvider({
    agentName,
    slot: "capture",
    value: defineInstrumentation({
      events: Object.fromEntries(HEARD_TYPES.map((type) => [type, record])),
    }),
  });
  finalizeInstrumentationProviders({ serviceName: agentName });
  return heard;
}

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const BOB = { ...ALICE, principalId: "bob" };

type Prompt = LanguageModelV4CallOptions["prompt"];
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
interface Call {
  readonly toolName: string;
  readonly input?: unknown;
  readonly toolCallId?: string;
}

/** What the prompt says so far: the latest person's text, and the results of the turn's calls. */
function readPrompt(prompt: Prompt) {
  const users = prompt.filter((message) => message.role === "user");
  const lastUser = users.at(-1);
  const lastUserIndex = lastUser === undefined ? -1 : prompt.lastIndexOf(lastUser);
  const text = JSON.stringify(lastUser?.content ?? "");
  const results = prompt
    .slice(lastUserIndex + 1)
    .flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [{ output: part.output, toolCallId: part.toolCallId, toolName: part.toolName }]
              : [],
          )
        : [],
    );
  return { results, said: (words: string) => text.includes(words), users: users.length };
}

/** A model that answers each request with what `script` returns for the prompt. */
function scriptedModel(
  script: (
    prompt: ReturnType<typeof readPrompt>,
    raw: Prompt,
  ) => StreamResult | readonly Call[] | string,
) {
  let count = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const next = script(readPrompt(prompt), prompt);
      if (typeof next === "string") return textStreamResult(next);
      if (Array.isArray(next)) {
        return toolCallsStreamResult(
          next.map((call: Call) => ({
            input: JSON.stringify(call.input ?? {}),
            toolCallId: call.toolCallId ?? `call_${count++}`,
            toolName: call.toolName,
          })),
        );
      }
      return next as StreamResult;
    },
    modelId: "scripted",
    provider: "eve-test",
  });
  return markMockModel(model);
}

/** A response that streams `calls`, then fails the way a dropped connection does. */
function failingAfterCalls(calls: readonly Call[]): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...calls.map((call, index) => ({
          input: JSON.stringify(call.input ?? {}),
          toolCallId: call.toolCallId ?? `call_dropped_${index}`,
          toolName: call.toolName,
          type: "tool-call" as const,
        })),
        {
          error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          type: "error",
        },
      ],
    }) as StreamResult["stream"],
  };
}

/** A promise the test resolves when it decides; `wait` is what the session awaits. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const wait = new Promise<T>((resolve) => (open = resolve));
  return { open, wait };
}

async function waitForOwnerGate<T>(
  promise: Promise<T>,
  label: string,
  events: () => readonly SessionStreamEvent[],
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for ${label}; parent events: ${events()
                  .map((event) => event.type)
                  .join(", ")}`,
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A reply that holds until `release` resolves. With `before`, that text streams first, so the
 * reply has started when it holds; without it, nothing has.
 */
function heldReply(text: string, release: Promise<void>, before?: string): StreamResult {
  return {
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "held", type: "text-start" });
        if (before !== undefined)
          controller.enqueue({ delta: before, id: "held", type: "text-delta" });
        await release;
        controller.enqueue({ delta: text, id: "held", type: "text-delta" });
        controller.enqueue({ id: "held", type: "text-end" });
        controller.enqueue({
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage,
        });
        controller.close();
      },
    }) as StreamResult["stream"],
  };
}

interface ToolSpec {
  readonly name: string;
  readonly approval?: boolean;
  readonly allowOtherResponders?: boolean;
  readonly inputSchema?: z.ZodType;
  readonly execute?: (input: unknown) => unknown;
  readonly workflow?: boolean;
}

type Stage = SessionStreamEvent[];

interface Session {
  /** Reads to the session's next turn boundary. */
  readonly next: (label: string) => Promise<Stage>;
  /** Reads through the first event `matches` accepts. */
  readonly until: (
    label: string,
    matches: (event: SessionStreamEvent) => boolean,
  ) => Promise<Stage>;
  readonly send: (message: string, auth?: SessionAuthContext) => Promise<void>;
  readonly forward: (callId: string, message: string) => Promise<void>;
  readonly answer: (
    interactionId: string,
    optionId: string,
    auth?: SessionAuthContext,
  ) => Promise<void>;
  readonly answerAndSend: (interactionId: string, message: string) => Promise<string>;
  readonly control: (
    kind: "cancel" | "clear" | "compact" | "reset",
    extra?: object,
  ) => Promise<void>;
  /** The approvals opened so far, oldest first. */
  readonly approvals: () => string[];
  readonly events: () => readonly SessionStreamEvent[];
}

async function withSession(
  name: string,
  options: {
    readonly message: string;
    readonly tools: readonly ToolSpec[];
    readonly model: MockLanguageModelV4;
    readonly hooks?: Readonly<Record<string, HookDefinition>>;
    readonly parent?: SessionParent;
  },
  body: (session: Session) => Promise<void>,
) {
  const ran: string[] = [];
  const heard = await hearInstrumentation(name);
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model: options.model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      ...Object.entries(options.hooks ?? {}).map(([slug, hook]) => ({
        loadNamespace: async () => ({ default: hook }),
        logicalPath: `hooks/${slug}.ts`,
      })),
      ...options.tools.map((tool) => ({
        loadNamespace: async () => ({
          default: tool.workflow
            ? defineWorkflowTool({
                description: `Run ${tool.name}.`,
                execute: waitingForCleanupWorkflow as WorkflowExecuteToolDefinition["execute"],
                inputSchema: {},
              })
            : defineTool({
                approval:
                  tool.approval === true
                    ? {
                        request: always(),
                        ...(tool.allowOtherResponders && {
                          response: () => ({ status: "allowed" as const }),
                        }),
                      }
                    : undefined,
                description: `Run ${tool.name}.`,
                execute: async (input) => {
                  ran.push(tool.name);
                  return tool.execute === undefined
                    ? { ran: tool.name }
                    : await tool.execute(input);
                },
                inputSchema: tool.inputSchema ?? z.object({}).passthrough(),
              }),
        }),
        logicalPath: `tools/${tool.name}.ts`,
      })),
    ],
  });
  const continuationToken = `http:${name}`;
  const events: SessionStreamEvent[] = [];

  const sessionId = await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: options.message },
        serializedContext: {
          ...buildSerializedContext({
            auth: ALICE,
            channelKind: options.parent === undefined ? "http" : "subagent",
            channelState:
              options.parent === undefined
                ? undefined
                : {
                    callId: options.parent.callId,
                    parentContinuationToken: `${name}:initial:reply`,
                    parentSessionId: options.parent.sessionId,
                    subagentName: name,
                  },
            continuationToken,
            parent: options.parent,
          }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    const commandInbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    // Each read gives up well inside the test's timeout, naming what it waited for and what the
    // session had written, so a stuck session reports where it stopped.
    const read = async (label: string, stage: Promise<Stage>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        stage,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for ${label} after: ${events.map((event) => event.type).join(", ")}`,
                ),
              ),
            20_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      events.push(...read);
      return read;
    };
    let deliveries = 0;
    try {
      await body({
        approvals: () =>
          events.flatMap((event) =>
            event.type === "interaction.opened" && event.data.request.kind === "approval"
              ? [event.data.interactionId]
              : [],
          ),
        async answer(interactionId, optionId, auth = ALICE) {
          await resumeHook(commandInbox, {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { answers: [{ interactionId, optionId }] },
          });
        },
        async answerAndSend(interactionId, message) {
          const delivery = createChannelDeliveryMetadata({
            channelKind: "http",
            channelName: "test",
          });
          await resumeHook(commandInbox, {
            auth: BOB,
            kind: "send",
            delivery,
            payload: { answers: [{ interactionId, optionId: "approve" }], message },
          });
          return delivery.deliveryId;
        },
        async control(kind, extra = {}) {
          await resumeHook(commandInbox, {
            auth: ALICE,
            deliveryId: `control_${deliveries++}`,
            kind,
            ...extra,
          });
        },
        events: () => events,
        async forward(callId, message) {
          const { parent } = options;
          if (parent === undefined) throw new Error("A forwarded call needs a parent session.");
          // The command a parent's agent session sends to serve another of its calls.
          await resumeHook(commandInbox, {
            auth: ALICE,
            caller: {
              callId: parent.callId,
              replyTo: { kind: "hook", token: `${name}:${callId}:reply` },
              servedCallId: callId,
              subagentName: name,
            },
            delivery: createChannelDeliveryMetadata({
              channelKind: "subagent",
              channelName: "subagent",
            }),
            kind: "send",
            payload: { message },
          });
        },
        next: (label) => read(label, stream.nextTurn()),
        async send(message, auth = ALICE) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { message },
          });
        },
        until: (label, matches) => read(label, stream.nextUntil(matches)),
      });
      await vi.waitFor(() => expectInstrumentationPairs(events, heard, run.runId));
    } finally {
      stream.dispose();
      const cleanup = run.cancel().catch(() => {});
      if (name === "edge-cancel-hung-task")
        await waitForOwnerGate(cleanup, "parent run cancel cleanup", () => events);
      else await cleanup;
    }
    return run.runId;
  });
  expectReadersAgree(events);
  expectInstrumentationPairs(events, heard, sessionId);
  return { events, heard, ran };
}

/**
 * What every finished stream must say, whatever happened in it: a settled turn leaves none of
 * its calls, runs or requests open, and a client folding the same stream shows each of its calls
 * settled.
 */
function expectReadersAgree(events: readonly SessionStreamEvent[]) {
  const { view } = viewOfEvents(events);
  const settledTurns = new Set(
    Object.values(view.turns).flatMap((turn) => (turn.status === "settled" ? [turn.turnId] : [])),
  );
  const turnOfRun = (runId: string) => {
    const owner = view.runs[runId]?.owner;
    return owner !== undefined && "turnId" in owner ? owner.turnId : undefined;
  };
  for (const run of Object.values(view.runs)) {
    const turnId = turnOfRun(run.runId);
    if (turnId !== undefined && settledTurns.has(turnId))
      expect(run.status, `run ${run.runId} of settled ${turnId}`).toBe("settled");
  }
  for (const call of Object.values(view.calls)) {
    const turnId = "runId" in call.owner ? turnOfRun(call.owner.runId) : undefined;
    if (turnId !== undefined && settledTurns.has(turnId))
      expect(call.status, `call ${call.callId} of settled ${turnId}`).toBe("settled");
  }
  if (view.session.status === "ended") {
    for (const interaction of Object.values(view.interactions))
      expect(interaction.status, `interaction ${interaction.interactionId}`).toBe("settled");
  }

  // A reader that receives every line twice, as a reconnect can, shows the same conversation.
  const conversation = conversationOf(events);
  expect(conversationOf(events.flatMap((event) => [event, event])).messages).toEqual(
    conversation.messages,
  );
  for (const message of conversation.messages) {
    const turnId = message.metadata?.turnId;
    if (turnId === undefined || !settledTurns.has(turnId)) continue;
    for (const part of message.parts.filter((part): part is EveToolPart => part.type === "tool"))
      expect(
        ["completed", "failed", "rejected", "cancelled"],
        `client part ${part.callId}`,
      ).toContain(part.state);
  }
}

/**
 * What instrumentation hears for the same session: each turn, call and request it hears begin
 * ends once at most, and once for each the stream settled; each attempt that started ends once.
 */
function expectInstrumentationPairs(
  events: readonly SessionStreamEvent[],
  all: readonly InstrumentationEvent[],
  sessionId: string,
) {
  // Providers are process-wide, so a child session and a cancelled session that an earlier test
  // left running report to the same one; this stream is its owner run's session.
  const sessionOf = (event: InstrumentationEvent) =>
    "sessionId" in event ? event.sessionId : "scope" in event ? event.scope.sessionId : undefined;
  const heard = all.filter((event) => sessionOf(event) === sessionId);
  const count = (type: string) => {
    const counts = new Map<string, number>();
    for (const event of heard)
      if (event.type === type) {
        const key = (event as { idempotencyKey?: string }).idempotencyKey ?? "";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    return counts;
  };
  for (const [begin, end] of [
    ["turn.started", "turn.settled"],
    ["call.requested", "call.settled"],
    ["interaction.opened", "interaction.settled"],
  ] as const) {
    const begun = count(begin);
    const ended = count(end);
    for (const [key, times] of begun) expect(times, `${begin} ${key}`).toBe(1);
    for (const [key, times] of ended) {
      expect(times, `${end} ${key}`).toBe(1);
      expect(begun.has(key), `${end} ${key} without ${begin}`).toBe(true);
    }
  }
  const streamed = (type: string) => events.filter((event) => event.type === type).length;
  expect(heard.filter((event) => event.type === "turn.settled")).toHaveLength(
    streamed("turn.settled"),
  );
  expect(heard.filter((event) => event.type === "call.settled")).toHaveLength(
    streamed("call.settled"),
  );
  for (const type of ["session.started", "session.ended"])
    expect(
      heard.filter((event) => event.type === type),
      type,
    ).toHaveLength(streamed(type));
  // Each attempt ends once, and an attempt that started ends once its turn has.
  const attemptEnds = new Map<string, number>();
  for (const event of heard)
    if (event.type === "model.settled" || event.type === "model.retried")
      attemptEnds.set(
        attemptIdempotencyKey(event.scope),
        (attemptEnds.get(attemptIdempotencyKey(event.scope)) ?? 0) + 1,
      );
  for (const [attemptId, times] of attemptEnds) expect(times, attemptId).toBe(1);
  const settledTurns = new Set(ofType(events, "turn.settled").map((event) => event.data.turnId));
  for (const event of heard)
    if (
      event.type === "model.started" &&
      event.scope.turnId !== undefined &&
      settledTurns.has(event.scope.turnId)
    )
      expect(
        attemptEnds.has(attemptIdempotencyKey(event.scope)),
        `${attemptIdempotencyKey(event.scope)} ended`,
      ).toBe(true);
}

const ofType = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T,
) =>
  events.filter((event): event is Extract<SessionStreamEvent, { type: T }> => event.type === type);

const settlements = (events: readonly SessionStreamEvent[]) =>
  ofType(events, "call.settled").map((event) => `${event.data.callId}:${event.data.outcome}`);

const turnOutcomes = (events: readonly SessionStreamEvent[]) =>
  ofType(events, "turn.settled").map((event) => `${event.data.turnId}:${event.data.outcome}`);

describe("tools that go wrong", () => {
  it("fails a call whose tool throws, and the model carries on to a reply", async () => {
    const { events } = await withSession(
      "edge-tool-throws",
      {
        message: "Look up the weather.",
        model: scriptedModel(({ results }) =>
          results.length === 0
            ? [{ toolName: "weather", toolCallId: "call_weather" }]
            : "Sorry, no weather.",
        ),
        tools: [
          {
            name: "weather",
            execute: () => {
              throw new Error("Weather service is down");
            },
          },
        ],
      },
      async (session) => {
        await session.next("turn");
      },
    );

    const [failed] = ofType(events, "call.settled");
    expect(failed?.data).toMatchObject({ callId: "call_weather", outcome: "failed" });
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  // The AI SDK answers a call it can't run itself, so the model hears why; eve runs nothing and,
  // as before v27, announces no call for it.
  it.each([
    {
      call: { input: { town: 3 }, toolName: "weather" },
      error: /city/,
      name: "input the tool's schema rejects",
    },
    { call: { toolName: "teleport" }, error: /teleport/, name: "a tool the agent doesn't have" },
  ])("tells the model about a call with $name, and runs nothing", async ({ call, error }) => {
    const told: unknown[] = [];
    const { events, ran } = await withSession(
      `edge-unrunnable-${call.toolName}`,
      {
        message: "Look up the weather.",
        model: scriptedModel(({ results }) => {
          if (results.length === 0) return [{ ...call, toolCallId: "call_bad" }];
          told.push(...results.map((result) => result.output));
          return "I couldn't look that up.";
        }),
        tools: [{ inputSchema: z.object({ city: z.string() }).strict(), name: "weather" }],
      },
      async (session) => {
        await session.next("turn");
      },
    );

    expect(ran).toEqual([]);
    expect(JSON.stringify(told)).toMatch(error);
    expect(ofType(events, "call.requested")).toEqual([]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs two calls one response gives the same id as two calls", async () => {
    const { events, ran } = await withSession(
      "edge-duplicate-ids",
      {
        message: "Check both cities.",
        model: scriptedModel(({ results }) =>
          results.length === 0
            ? [
                { input: { city: "Oslo" }, toolName: "weather", toolCallId: "call_0" },
                { input: { city: "Rome" }, toolName: "weather", toolCallId: "call_0" },
              ]
            : `Got ${results.length} results.`,
        ),
        tools: [{ name: "weather", execute: (input) => input }],
      },
      async (session) => {
        await session.next("turn");
      },
    );

    expect(ran).toEqual(["weather", "weather"]);
    expect(settlements(events).sort()).toEqual(["call_0:completed", "call_0_2:completed"]);
    expect(ofType(events, "content.completed").at(-1)?.data).toMatchObject({
      value: "Got 2 results.",
    });
  });
});

describe("calls in flight", () => {
  it("settles a batch whose calls fail, run and wait on a person, each on its own", async () => {
    const { events, ran } = await withSession(
      "edge-mixed-batch",
      {
        message: "Check, break and deploy.",
        model: scriptedModel(({ results }) =>
          results.length === 0
            ? [
                { toolName: "check", toolCallId: "call_check" },
                { toolName: "broken", toolCallId: "call_broken" },
                { toolName: "deploy", toolCallId: "call_deploy" },
              ]
            : `Done with ${results.length} calls.`,
        ),
        tools: [
          { name: "check" },
          {
            name: "broken",
            execute: () => {
              throw new Error("Broken on purpose");
            },
          },
          { approval: true, name: "deploy" },
        ],
      },
      async (session) => {
        await session.next("asks");
        // What needed nobody has already settled while the approval waits.
        expect(settlements(session.events()).sort()).toEqual([
          "call_broken:failed",
          "call_check:completed",
        ]);
        await session.answer(session.approvals()[0]!, "approve");
        await session.until("done", (event) => event.type === "turn.settled");
      },
    );

    expect(ran.sort()).toEqual(["broken", "check", "deploy"]);
    expect(settlements(events).sort()).toEqual([
      "call_broken:failed",
      "call_check:completed",
      "call_deploy:completed",
    ]);
    expect(ofType(events, "content.completed").at(-1)?.data).toMatchObject({
      value: "Done with 3 calls.",
    });
  });

  it.each(["idle", "stale"] as const)(
    "settles a non-targeting cancel (%s) without cancelling another turn",
    async (mode) => {
      const release = gate();
      const model = scriptedModel(({ said }) =>
        said("First")
          ? heldReply("Alice's report is ready.", release.wait)
          : "Bob's report is ready.",
      );
      const { events } = await withSession(
        `edge-cancel-${mode}-receipt`,
        { message: "First, read Alice's report.", tools: [], model },
        async (session) => {
          if (mode === "stale") {
            await session.until("first model", (event) => event.type === "model.started");
            await session.control("cancel", { turnId: "turn_retired" });
          }
          release.open();
          await session.next("Alice's report");
          if (mode === "idle") await session.control("cancel");
          await session.send("Next, read Bob's report.");
          await session.next("Bob's report");
        },
      );
      expect(ofType(events, "delivery.admitted")).toHaveLength(3);
      expect(ofType(events, "delivery.admitted").map((event) => event.data.deliveryId)).toContain(
        "control_0",
      );
      expect(
        ofType(events, "delivery.settled").find((event) => event.data.deliveryId === "control_0")
          ?.data.outcome,
      ).toBe("ignored");
      expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    },
  );

  it("interrupts a running tool when the turn is cancelled, and drops its late result", async () => {
    const started = gate();
    const finish = gate();
    const { events } = await withSession(
      "edge-cancel-running-tool",
      {
        message: "Run the long job.",
        model: scriptedModel(({ results, said }) => {
          if (said("Status?")) return "Nothing is running.";
          return results.length === 0
            ? [{ toolName: "long_job", toolCallId: "call_long" }]
            : "The job finished.";
        }),
        tools: [
          {
            name: "long_job",
            execute: async () => {
              started.open();
              await finish.wait;
              return { finished: true };
            },
          },
        ],
      },
      async (session) => {
        await started.wait;
        await session.control("cancel");
        await session.until("cancelled", (event) => event.type === "turn.settled");
        finish.open();
        await session.send("Status?");
        await session.next("next turn");
      },
    );

    expect(settlements(events)).toEqual(["call_long:interrupted"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    expect(JSON.stringify(events)).not.toContain("The job finished.");
  });

  it("preserves each forwarded call when two messages coalesce behind a running tool", async () => {
    const started = gate();
    const release = gate();
    const { events } = await withSession(
      "edge-coalesced-forwarded-calls",
      {
        message: "Prepare the review.",
        parent: {
          callId: "opening",
          rootSessionId: "parent",
          sessionId: "parent",
          turn: { id: "parent-turn", sequence: 1 },
        },
        model: scriptedModel(({ results, said }) =>
          said("Check the database")
            ? "Both checks are complete."
            : results.length === 0
              ? [{ toolName: "prepare_review" }]
              : "Review prepared.",
        ),
        tools: [
          {
            name: "prepare_review",
            execute: async () => {
              started.open();
              await release.wait;
              return "Ready.";
            },
          },
        ],
      },
      async (session) => {
        await started.wait;
        try {
          await session.forward("deployment-check", "Check the deployment.");
          await session.send("Check the notes.");
          await session.forward("database-check", "Check the database.");
        } finally {
          release.open();
        }
        await session.until(
          "forwarded messages consumed",
          (event) =>
            event.type === "delivery.consumed" &&
            event.data.parts.some(
              (part) => part.kind === "text" && part.text.includes("Check the database"),
            ),
        );
        let settled = false;
        await session.until("both forwarded messages handled", (event) => {
          settled ||= event.type === "turn.settled";
          return settled && event.meta.endOfLine !== false;
        });
      },
    );
    const view = viewOfEvents(events).view;
    const received = Object.values(view.deliveries).filter((delivery) =>
      delivery.parts?.some((part) => part.kind === "text" && part.text.startsWith("Check the")),
    );
    expect(received).toHaveLength(3);
    expect(received.map((delivery) => delivery.source)).toEqual([
      { channel: "subagent", caller: { callId: "deployment-check", sessionId: "parent" } },
      { channel: "http" },
      { channel: "subagent", caller: { callId: "database-check", sessionId: "parent" } },
    ]);
    expect(received.map((delivery) => [delivery.turnId, delivery.outcome])).toEqual([
      ["turn_0", "handled"],
      ["turn_0", "handled"],
      ["turn_0", "handled"],
    ]);
  });

  it("steers a model that hasn't started its reply toward the message that arrived", async () => {
    const release = gate();
    const replies: string[] = [];
    const { events } = await withSession(
      "edge-steer-before-output",
      {
        message: "Write a long story.",
        model: scriptedModel(({ said }) => {
          if (said("Make it short")) {
            replies.push("short");
            return "The end.";
          }
          replies.push("long");
          return heldReply("Once upon a time", release.wait);
        }),
        tools: [],
      },
      async (session) => {
        await session.until("thinking", (event) => event.type === "model.started");
        await session.send("Make it short.");
        await session.until("done", (event) => event.type === "turn.settled");
        release.open();
      },
    );

    expect(replies).toEqual(["long", "short"]);
    // One turn takes both messages: the cut run never replied, and the steered one did.
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    expect(ofType(events, "delivery.consumed")).toHaveLength(2);
    expect(ofType(events, "content.completed").map((event) => event.data.value)).toEqual([
      "The end.",
    ]);
  });

  it("finishes a reply already streaming, and answers a message sent meanwhile in its own turn", async () => {
    const release = gate();
    const { events } = await withSession(
      "edge-steer-after-output",
      {
        message: "Write a long story.",
        model: scriptedModel(({ said }) =>
          said("Make it short")
            ? "The end."
            : heldReply(" there was a dragon.", release.wait, "Once"),
        ),
        tools: [],
      },
      async (session) => {
        await session.until("streaming", (event) => event.type === "content.delta");
        await session.send("Make it short.");
        setTimeout(release.open, 500);
        await session.next("story");
        await session.next("short");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    expect(ofType(events, "content.completed").map((event) => event.data.value)).toEqual([
      "Once there was a dragon.",
      "The end.",
    ]);
  });
});

describe("approvals off the happy path", () => {
  const deployModel = () =>
    scriptedModel(({ results, said }) => {
      if (said("Never mind")) return "Okay, stopping.";
      // A stale answer reaches the model as the person's text, naming the request it answered.
      // An answer to a request the session never made: the model asks for the deploy again.
      if (said("interaction_missing")) return [{ toolName: "deploy", toolCallId: "call_deploy" }];
      if (said("requestId")) return "That was already done.";
      if (results.length > 0) return `Deploy finished: ${JSON.stringify(results[0]?.output)}`;
      return [{ toolName: "deploy", toolCallId: "call_deploy" }];
    });
  const deployTools: ToolSpec[] = [{ approval: true, name: "deploy" }];

  it("admits another person's queued message without repeating the held turn's pause", async () => {
    const { events, ran } = await withSession(
      "edge-held-message-admission",
      {
        message: "Deploy Alice's release.",
        model: scriptedModel(({ said, results }) =>
          said("Bob asks for a status update.")
            ? "The release is ready."
            : results.length > 0
              ? "Alice's release finished."
              : [{ toolName: "deploy", toolCallId: "call_deploy" }],
        ),
        tools: deployTools,
      },
      async (session) => {
        await session.next("Alice's approval");
        const request = session.approvals()[0]!;
        await session.send("Bob asks for a status update.", BOB);
        await session.until(
          "Bob's admitted message",
          (event) => event.type === "delivery.admitted" && event.data.principal?.id === "bob",
        );
        await session.answer(request, "approve");
        const alice = await session.next("Alice's completed turn");
        expect(turnOutcomes(alice)).toEqual(["turn_0:completed"]);
        await session.until(
          "Bob's completed turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
      },
    );
    expect(ran).toEqual(["deploy"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    expect(ofType(events, "turn.paused")).toHaveLength(1);
  });

  it("admits a held clear once and applies it after the approved turn ends", async () => {
    const { events, ran } = await withSession(
      "edge-held-clear-admission",
      { message: "Deploy Alice's release.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("Alice's approval");
        const request = session.approvals()[0]!;
        await session.control("clear");
        await session.until(
          "the held clear",
          (event) => event.type === "delivery.admitted" && event.data.deliveryId === "control_0",
        );
        await session.answer(request, "approve");
        await session.until(
          "the applied clear",
          (event) => event.type === "context.settled" && event.data.kind === "clear",
        );
        await session.until(
          "the clear receipt",
          (event) => event.type === "delivery.settled" && event.data.deliveryId === "control_0",
        );
      },
    );
    expect(ran).toEqual(["deploy"]);
    expect(
      ofType(events, "delivery.admitted").filter((event) => event.data.deliveryId === "control_0"),
    ).toHaveLength(1);
    expect(
      ofType(events, "delivery.settled")
        .filter((event) => event.data.deliveryId === "control_0")
        .map((event) => event.data.outcome),
    ).toEqual(["applied"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("rejects a call its approver cancels, and the model hears it didn't run", async () => {
    const { events, ran } = await withSession(
      "edge-approval-cancel",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        await session.answer(session.approvals()[0]!, "deny");
        await session.next("rejected");
      },
    );

    expect(ran).toEqual([]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "declined",
    ]);
    expect(settlements(events)).toEqual(["call_deploy:rejected"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("separates another person's answer from their queued message", async () => {
    let messageId = "";
    const { events, ran } = await withSession(
      "edge-split-answer-message",
      {
        message: "Deploy it.",
        model: scriptedModel((prompt) =>
          prompt.said("Bob follows up")
            ? "Thanks, Bob."
            : prompt.results.length > 0
              ? "Deployed."
              : [{ toolName: "deploy" }],
        ),
        tools: [{ approval: true, allowOtherResponders: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks Alice for approval");
        messageId = await session.answerAndSend(session.approvals()[0]!, "Bob follows up.");
        await session.next("Alice's approved turn finishes");
        expect(
          ofType(session.events(), "delivery.consumed").map((event) => event.data.deliveryId),
        ).not.toContain(messageId);
        await session.send("Alice starts the next turn.");
        await session.until(
          "Bob's message has its turn",
          (event) => event.type === "delivery.settled" && event.data.deliveryId === messageId,
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    const answerId = `answers_${messageId}`;
    for (const id of [answerId, messageId]) {
      expect(
        events
          .filter(
            (event) =>
              (event.type === "delivery.admitted" ||
                event.type === "delivery.consumed" ||
                event.type === "delivery.settled") &&
              event.data.deliveryId === id,
          )
          .map((event) => event.type),
      ).toEqual(["delivery.admitted", "delivery.consumed", "delivery.settled"]);
    }
    expect(ofType(events, "response.submitted").map((event) => event.data.deliveryId)).toEqual([
      answerId,
    ]);
  });

  it("runs a call once when its approval is answered twice; the late answer reads as text", async () => {
    const { events, ran } = await withSession(
      "edge-approval-twice",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.answer(approval!, "approve");
        await session.next("approved");
        // A closed request takes no answer; the session reads it as the person's words, so it
        // can't approve anything again.
        await session.answer(approval!, "approve");
        await session.until("reply", (event) => event.type === "turn.settled");
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(settlements(events)).toEqual(["call_deploy:completed"]);
    expect(ofType(events, "response.submitted")).toHaveLength(1);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
  });

  it("reads an answer to a request it doesn't know as a message, which withdraws the open one", async () => {
    const { events, ran } = await withSession(
      "edge-answer-nothing",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        await session.answer("interaction_missing", "approve");
        // The model reads it, and asks again.
        const [first] = session.approvals();
        await session.until(
          "asks again",
          (event) => event.type === "interaction.opened" && event.data.interactionId !== first,
        );
        await session.answer(session.approvals()[1]!, "approve");
        await session.until("approved", (event) => event.type === "turn.settled");
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(
      ofType(events, "interaction.settled").map((event) => [event.data.outcome, event.data.reason]),
    ).toEqual([
      ["withdrawn", "superseded-by-message"],
      ["accepted", undefined],
    ]);
    expect(settlements(events)).toEqual(["call_deploy:rejected", "call_deploy_2:completed"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("keeps the owner's standing answer through repeated refusals of another person's batch answer", async () => {
    const { events, ran } = await withSession(
      "edge-refused-batch",
      {
        message: "Deploy twice.",
        model: scriptedModel(({ results }) =>
          results.length === 0
            ? [
                { toolName: "deploy", toolCallId: "call_a" },
                { toolName: "deploy", toolCallId: "call_b" },
              ]
            : "Deployed.",
        ),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("the approvals");
        const [first, second] = session.approvals();
        await session.answer(first!, "approve");
        await session.until(
          "the owner's answer stands",
          (event) => event.type === "response.admitted",
        );
        for (const attempt of ["first", "second"]) {
          await session.answer(second!, "approve", BOB);
          await session.until(
            `Bob's ${attempt} answer is refused`,
            (event) => event.type === "delivery.settled" && event.data.outcome === "refused",
          );
        }
        await session.answer(second!, "approve");
        await session.until(
          "the approved turn finishes",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );
    expect(ran).toEqual(["deploy", "deploy"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    const refused = ofType(events, "delivery.settled").filter(
      (event) => event.data.outcome === "refused",
    );
    expect(refused).toHaveLength(2);
    expect(new Set(refused.map((event) => event.data.deliveryId)).size).toBe(2);
  });

  it("waits on the next approvals after a message steered past the last ones", async () => {
    let asked = 0;
    const { events, ran } = await withSession(
      "edge-steer-then-ask",
      {
        message: "Deploy twice.",
        model: scriptedModel(({ results }) => {
          if (results.length === 0 || asked === 1) {
            asked += 1;
            return [
              { toolName: "deploy", toolCallId: `call_${asked}a` },
              { toolName: "deploy", toolCallId: `call_${asked}b` },
            ];
          }
          return "Deployed.";
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("the first approvals");
        await session.answer(session.approvals()[0]!, "approve");
        await session.until(
          "the first answer stands",
          (event) => event.type === "response.admitted",
        );
        await session.until("the remaining approval", (event) => event.type === "turn.paused");
        await session.send("Actually, go ahead with what you have.");
        const opened = new Set<string>();
        await session.until("the next approvals", (event) => {
          if (event.type === "interaction.opened") opened.add(event.data.interactionId);
          return (
            event.type === "turn.paused" &&
            event.data.awaiting.length === 2 &&
            event.data.awaiting.every(({ interactionId }) => opened.has(interactionId))
          );
        });
      },
    );
    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.opened")).toHaveLength(4);
    expect(ofType(events, "turn.paused").at(-1)?.data.awaiting).toHaveLength(2);
  });

  it("settles a cancel that arrives as its turn ends as ignored", async () => {
    const hold = gate();
    const held = gate();
    const { events } = await withSession(
      "edge-cancel-at-end",
      {
        hooks: {
          hold: defineHook({
            events: {
              "turn.settled": async () => {
                held.open();
                await hold.wait;
              },
            },
          }),
        },
        message: "Hi.",
        model: scriptedModel(() => "Hello."),
        tools: [],
      },
      async (session) => {
        try {
          await held.wait;
          await session.control("cancel");
        } finally {
          hold.open();
        }
        await session.until(
          "the cancel settles",
          (event) => event.type === "delivery.settled" && event.data.deliveryId === "control_0",
        );
      },
    );
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    expect(
      ofType(events, "delivery.settled").find((event) => event.data.deliveryId === "control_0")
        ?.data.outcome,
    ).toBe("ignored");
  });

  it("cancels a turn waiting on approval: the request closes, a late answer runs nothing", async () => {
    const { events, ran } = await withSession(
      "edge-approval-then-cancel",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.control("cancel");
        await session.next("cancelled");
        await session.answer(approval!, "approve");
        await session.send("Never mind, how are you?");
        await session.next("next turn");
      },
    );

    expect(ran).toEqual([]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    expect(settlements(events)).toEqual(["call_deploy:interrupted"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "interrupted",
    ]);
    expect(ofType(events, "response.submitted")).toEqual([]);
  });

  it("takes up a message sent while an approval waits, and the call doesn't run", async () => {
    const { events, ran } = await withSession(
      "edge-approval-then-message",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        await session.send("Never mind, don't deploy.");
        await session.until(
          "reply",
          (event) =>
            event.type === "content.completed" &&
            JSON.stringify(event.data).includes("Okay, stopping."),
        );
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    expect(ran).toEqual([]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "withdrawn",
    ]);
    expect(ofType(events, "call.settled").map((event) => event.data.outcome)).not.toContain(
      "completed",
    );
  });

  it("ends a session reset while an approval waits, closing everything it held open", async () => {
    const { events, ran } = await withSession(
      "edge-approval-then-reset",
      { message: "Deploy it.", model: deployModel(), tools: deployTools },
      async (session) => {
        await session.next("asks");
        await session.control("reset", { reason: "start over" });
        await session.until("ended", (event) => event.type === "session.ended");
      },
    );

    expect(ran).toEqual([]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled"]);
    expect(ofType(events, "session.ended")).toHaveLength(1);
    // The session's end is its last line.
    expect(events.at(-1)?.type).toBe("session.ended");
  });
});

describe("models that fail", () => {
  it.each([
    { delegated: false, attempts: 1, outcome: "completed" },
    { delegated: true, attempts: 2, outcome: "failed" },
  ] as const)(
    "handles an empty stop response with delegated=$delegated",
    async ({ delegated, attempts, outcome }) => {
      let calls = 0;
      await withSession(
        `empty-stop-${delegated ? "child" : "root"}`,
        {
          message: "Alice asks for the weekly summary.",
          tools: [],
          parent: delegated
            ? {
                sessionId: "parent",
                rootSessionId: "parent",
                callId: "summary",
                turn: { id: "parent-turn", sequence: 1 },
              }
            : undefined,
          model: scriptedModel(() => {
            calls += 1;
            return "";
          }),
        },
        async (session) => {
          const events = await session.next("empty stop response");
          expect(events.find((event) => event.type === "turn.settled")?.data).toMatchObject({
            outcome,
          });
          expect(calls).toBe(attempts);
        },
      );
    },
  );

  it("abandons the calls a dropped response streamed, and the retry's calls run once", async () => {
    let attempts = 0;
    const { events, ran } = await withSession(
      "edge-dropped-response",
      {
        message: "Look up the weather.",
        model: scriptedModel(({ results }) => {
          if (results.length > 0) return "It's sunny.";
          attempts += 1;
          return attempts === 1
            ? failingAfterCalls([{ toolName: "weather", toolCallId: "call_first" }])
            : [{ toolName: "weather", toolCallId: "call_second" }];
        }),
        tools: [{ name: "weather" }],
      },
      async (session) => {
        await session.next("turn");
      },
    );

    expect(ran).toEqual(["weather"]);
    expect(settlements(events)).toEqual(["call_first:abandoned", "call_second:completed"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    // A reader shows the call the turn kept, not the one the retry replaced.
    const calls = conversationOf(events)
      .messages.flatMap((message) => message.parts)
      .filter((part): part is EveToolPart => part.type === "tool");
    expect(calls.map((part) => part.callId)).toEqual(["call_second"]);
  });

  it("fails the turn when the account can't pay, and the session takes the next message", async () => {
    let declined = false;
    const { events } = await withSession(
      "edge-model-unpaid",
      {
        message: "Hello?",
        model: scriptedModel(({ said }) => {
          if (said("again") && declined) return "I'm back.";
          declined = true;
          throw Object.assign(new Error("Payment required"), { statusCode: 402 });
        }),
        tools: [],
      },
      async (session) => {
        await session.next("failed");
        await session.send("Try again.");
        await session.next("recovered");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:failed", "turn_1:completed"]);
    expect(ofType(events, "session.ended")).toEqual([]);
  });

  it("ends the session when the provider rejects the key, naming the turn it failed in", async () => {
    const { events } = await withSession(
      "edge-model-unauthorized",
      {
        message: "Hello?",
        model: scriptedModel(() => {
          throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
        }),
        tools: [],
      },
      async (session) => {
        await session.until("ended", (event) => event.type === "session.ended");
      },
    );

    // The session failed, so its end closes the turn, which carries no error of its own: a
    // channel posts one notice, and the turn's failure reads as the session's error.
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled"]);
    const [ended] = ofType(events, "session.ended");
    expect(ended?.data).toMatchObject({
      cause: { turnId: "turn_0" },
      error: { message: expect.stringContaining("Invalid API key") },
      outcome: "failed",
    });
    expect(events.at(-1)?.type).toBe("session.ended");
    expect(failure(viewOfEvents(events).view, "turn_0")?.message).toContain("Invalid API key");
  });
});

describe("work delegated to a child session", () => {
  it("finishes a cancelled task even when its run never reports, then starts the next turn", async () => {
    const running = gate();
    const never = gate();
    const { events } = await withSession(
      "edge-cancel-hung-task",
      {
        message: "Start the slow work, then cancel it.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const first = JSON.stringify(raw.find((message) => message.role === "user")?.content);
          if (first.includes("CHILD:")) {
            running.open();
            return heldReply("Child result.", never.wait);
          }
          if (!prompt.includes('"toolName":"agent"'))
            return [
              { toolName: "agent", toolCallId: "call_agent", input: { message: "CHILD: work" } },
            ];
          if (!prompt.includes('"toolName":"eve__task_cancel"')) {
            const taskId = /Started task ([\w-]+)/u.exec(prompt)?.[1];
            if (!taskId) throw new Error("No task id in the model prompt");
            return [{ toolName: "eve__task_cancel", toolCallId: "call_cancel", input: { taskId } }];
          }
          return "Cancelled.";
        }),
        tools: [],
      },
      async (session) => {
        await session.until("task started", (event) => event.type === "task.started");
        await waitForOwnerGate(running.wait, "child model start", session.events);
        await session.next("cancelled task's turn");
        await waitForOwnerGate(session.send("Next turn."), "next turn delivery", session.events);
        await session.next("next turn");
        // The cancelled run may still address the owner after the task has ended.
        const taskId = ofType(session.events(), "task.ended")[0]!.data.taskId;
        const runs = await (
          await getWorld()
        ).runs.list({
          workflowName: workflowToolRunWorkflowReference.workflowId,
          pagination: { limit: 100 },
          resolveData: "none",
        });
        expect(runs.data).toHaveLength(1);
        await waitForOwnerGate(
          resumeHook(sessionInboxHookToken(`http:edge-cancel-hung-task`), {
            kind: "request",
            from: {
              callId: "call_agent",
              input: { message: "CHILD: work" },
              runId: runs.data[0]!.runId,
              sequence: 0,
              stepIndex: 0,
              taskId,
              toolName: "agent",
              turnId: "turn_0",
            },
            replyTo: "late-question",
            request: {
              kind: "ask",
              control: "late-control",
              request: { prompt: "A late question", title: "Late question", options: [] },
            },
          }),
          "late question delivery",
          session.events,
        );
        await session.send("One more update.");
        await session.next("later turn");
      },
    );
    expect(turnOutcomes(events)).toEqual([
      "turn_0:completed",
      "turn_1:completed",
      "turn_2:completed",
    ]);
    expect(ofType(events, "interaction.opened")).toEqual([]);
    const [ended] = ofType(events, "task.ended");
    expect(ended?.data.outcome).toBe("cancelled");
    expect(
      ofType(events, "call.settled").find((event) => event.data.callId === "call_cancel")?.data,
    ).toMatchObject({ output: `Stopped ${ended!.data.taskId}; it won't report back.` });
  });

  it("relays a child's approval to its parent, and answering it there runs the child's call", async () => {
    const { events, ran } = await withSession(
      "edge-child-approval",
      {
        message: "Delegate the deploy.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const called = (tool: string) => prompt.includes(`"toolName":"${tool}"`);
          // The child, whose conversation starts with the parent's message: deploys, behind an
          // approval, and reports.
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:")) {
            return called("deploy")
              ? "Child deployed."
              : [{ toolName: "deploy", toolCallId: "call_child_deploy" }];
          }
          // The parent: delegates once, waits for its child, and reports. A delegated call's
          // result arrives when its task ends, so the prompt shows the call before it does.
          if (!called("agent"))
            return [
              {
                input: { message: "CHILD: deploy it." },
                toolName: "agent",
                toolCallId: "call_agent",
              },
            ];
          if (!called("eve__task_wait"))
            return [{ input: {}, toolName: "eve__task_wait", toolCallId: "call_wait" }];
          return "The child is done.";
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("relayed approval pause");
        await session.answer(session.approvals()[0]!, "approve");
        const answered = await session.until(
          "answer settlement",
          (event) => event.type === "delivery.settled",
        );
        expect(ofType(answered, "delivery.settled").at(-1)?.data).toMatchObject({
          outcome: "handled",
          turnId: "turn_0",
        });
        expect(turnOutcomes(answered)).toEqual(["turn_0:completed"]);
      },
    );

    expect(ran).toEqual(["deploy"]);
    // The parent asks on the call that waits for the child, naming the child's own request.
    const [relayed] = ofType(events, "interaction.opened");
    expect(relayed?.data).toMatchObject({
      origin: { call: { callId: "call_child_deploy", name: "deploy" } },
      request: { kind: "approval" },
      subject: { callId: "call_agent" },
    });
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(
      ofType(events, "call.settled").find((event) => event.data.callId === "call_agent")?.data,
    ).toMatchObject({ outcome: "completed", output: "Child deployed." });
    expect(ofType(events, "child.opened")).toHaveLength(1);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("tells the person work is underway while a child works, then reports its result", async () => {
    const childWorks = gate();
    const blocks = new Set<string>();
    const { events } = await withSession(
      "edge-child-underway",
      {
        message: "Delegate the deploy; no need to wait on it.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          if (prompt.includes("If the person should hear from you now")) blocks.add("person");
          if (prompt.includes("Only your final reply reaches your caller")) blocks.add("caller");
          // The child reports once the test lets it.
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:"))
            return heldReply("Child deployed.", childWorks.wait);
          // The parent delegates, says the work is underway, and reports the child's result.
          if (!prompt.includes('"toolName":"agent"'))
            return [
              {
                input: { message: "CHILD: deploy it." },
                toolName: "agent",
                toolCallId: "call_agent",
              },
            ];
          if (!prompt.includes("The deploy is underway.")) return "The deploy is underway.";
          return "The deploy is done.";
        }),
        tools: [],
      },
      async (session) => {
        await session.until(
          "underway",
          (event) => event.type === "content.completed" && event.data.kind === "text",
        );
        childWorks.open();
        await session.until("done", (event) => event.type === "turn.settled");
      },
    );

    // A person reads the text a held turn writes, so both texts are replies, and the model is told
    // it may confirm the work is underway.
    expect(
      ofType(events, "content.completed").flatMap((event) =>
        event.data.kind === "text" ? [[event.data.value, event.data.phase]] : [],
      ),
    ).toEqual([
      ["The deploy is underway.", "reply"],
      ["The deploy is done.", "reply"],
    ]);
    expect([...blocks]).toEqual(["person"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });
});

describe("deliveries a child session reads", () => {
  it("name the call each serves, a follow-up's own call included", async () => {
    let childEvents: SessionStreamEvent[] = [];
    const { events } = await withSession(
      "edge-child-callers",
      {
        message: "Ask the child twice.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const called = (callId: string) => prompt.includes(`"toolCallId":"${callId}"`);
          // The child answers the last message it read.
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:")) {
            const last = raw.findLast((message) => message.role === "user");
            return JSON.stringify(last?.content).includes("second") ? "Child two." : "Child one.";
          }
          // The parent starts the child, waits for it, then continues the same task by its id.
          if (!called("call_one"))
            return [
              { input: { message: "CHILD: first" }, toolName: "agent", toolCallId: "call_one" },
            ];
          if (!called("call_wait_one"))
            return [{ input: {}, toolName: "eve__task_wait", toolCallId: "call_wait_one" }];
          const taskId = /Started task ([\w-]+)/u.exec(prompt)?.[1];
          if (!called("call_two"))
            return [
              {
                input: { message: "CHILD: second", taskId },
                toolName: "agent",
                toolCallId: "call_two",
              },
            ];
          if (!called("call_wait_two"))
            return [{ input: {}, toolName: "eve__task_wait", toolCallId: "call_wait_two" }];
          return "Both done.";
        }),
        tools: [],
      },
      async (session) => {
        await session.until("done", (event) => event.type === "turn.settled");
        const [opened] = ofType(session.events(), "child.opened");
        const read = readSessionEventHistory(opened!.data.sessionId).getReader();
        for (let next = await read.read(); !next.done; next = await read.read())
          childEvents.push(next.value);
      },
    );

    expect(ofType(events, "child.opened")).toHaveLength(1);
    expect(
      ofType(childEvents, "delivery.admitted").map((event) =>
        event.data.source !== undefined && "caller" in event.data.source
          ? event.data.source.caller?.callId
          : undefined,
      ),
    ).toEqual(["call_one", "call_two"]);
  });
});

describe("controls between turns", () => {
  it("clears the conversation so the next turn's model reads only the new message", async () => {
    const prompts: number[] = [];
    const { events } = await withSession(
      "edge-clear",
      {
        message: "Remember the number 42.",
        model: scriptedModel(({ users }) => {
          prompts.push(users);
          return "Noted.";
        }),
        tools: [],
      },
      async (session) => {
        await session.next("first");
        await session.control("clear");
        await session.until("cleared", (event) => event.type === "context.settled");
        await session.send("What number?");
        await session.next("second");
      },
    );

    expect(prompts).toEqual([1, 1]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
  });

  it("compacts between turns, and the next turn reads the summary", async () => {
    const { events } = await withSession(
      "edge-compact",
      {
        message: "Remember the number 42.",
        model: scriptedModel((_prompt, raw) =>
          JSON.stringify(raw).includes("What number")
            ? JSON.stringify(raw).includes("SUMMARY-42")
              ? "It was 42."
              : "I don't know."
            : JSON.stringify(raw).includes("42")
              ? "SUMMARY-42"
              : "Noted.",
        ),
        tools: [],
      },
      async (session) => {
        await session.next("first");
        await session.control("compact");
        await session.until("compacted", (event) => event.type === "context.settled");
        await session.send("What number?");
        await session.next("second");
      },
    );

    expect(ofType(events, "context.settled").map((event) => event.data.outcome)).toEqual([
      "completed",
    ]);
    expect(ofType(events, "content.completed").at(-1)?.data).toMatchObject({
      value: "It was 42.",
    });
  });

  it("cancels a turn before it takes its message, and the cancel settles that message", async () => {
    const prompts: string[][] = [];
    let admitted = 0;
    const { events } = await withSession(
      "edge-cancel-before-consumption",
      {
        // A hook may cancel as the message is admitted, before the turn consumes it.
        hooks: {
          stop: defineHook({
            events: {
              "delivery.admitted": (_event, ctx) => {
                // The second message; a retried step would admit it again, and not cancel then.
                if (++admitted === 2) ctx.cancel();
              },
            },
          }),
        },
        message: "Hi.",
        model: scriptedModel((_prompt, raw) => {
          prompts.push(
            raw.flatMap((message) =>
              message.role === "user" ? [JSON.stringify(message.content)] : [],
            ),
          );
          return "Hello.";
        }),
        tools: [],
      },
      async (session) => {
        await session.next("first");
        await session.send("Never mind.");
        await session.next("cancelled");
        await session.send("Still there?");
        await session.next("next");
      },
    );

    // The step that admitted the message writes it once, and isn't retried.
    expect(ofType(events, "session.started")).toHaveLength(1);
    const [, cancelled, next] = ofType(events, "delivery.admitted").map(
      (event) => event.data.deliveryId,
    );
    expect(turnOutcomes(events)).toEqual([
      "turn_0:completed",
      "turn_1:cancelled",
      "turn_2:completed",
    ]);
    expect(ofType(events, "delivery.consumed").map((event) => event.data.deliveryId)).toEqual([
      "delivery-initial",
      cancelled,
      next,
    ]);
    expect(ofType(events, "delivery.settled").map((event) => event.data)).toEqual([
      expect.objectContaining({ deliveryId: "delivery-initial", outcome: "handled" }),
      expect.objectContaining({ deliveryId: cancelled, outcome: "handled", turnId: "turn_1" }),
      expect.objectContaining({ deliveryId: next, outcome: "handled", turnId: "turn_2" }),
    ]);
    // The cancelled turn's message stays in history once, as it would if its model had started.
    expect(prompts.at(-1)?.filter((content) => content.includes("Never mind."))).toHaveLength(1);
  });
});
