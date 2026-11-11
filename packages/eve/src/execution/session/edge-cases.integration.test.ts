import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { DeliverPayload, SessionAuthContext, SessionParent } from "#channel/types.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalResponsePolicy } from "#approval/definition.js";
import { conversationOf } from "#client/conversation.js";
import type { EveToolPart } from "#client/message-types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
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
import { toAiSdkLanguageModel } from "#internal/runtime-model.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  textStreamResult,
  toolCallsStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import { readSessionEventHistory } from "#execution/session-event-stream.js";
import { viewOfEvents } from "#protocol/session-projection/fold.js";
import { failure } from "#protocol/session-projection/selectors.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { defineMemory } from "#public/memory/index.js";
import { DENY_OPTION_ID } from "#shared/input.js";
import { always } from "#tools/approval/policies.js";
import {
  defineTool,
  disableTool,
  type ToolAuthProvider,
  type ToolContext,
} from "#tools/definition.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { z } from "zod";
import {
  defineWorkflowTool,
  type WorkflowExecuteToolDefinition,
} from "#tools/workflow-definition.js";
import {
  holdUntilAbortedWorkflow,
  receiveDelegatedResultWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";

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

/** A model that answers each request with what `script` returns for the prompt and tool names. */
function scriptedModel(
  script: (
    prompt: ReturnType<typeof readPrompt>,
    raw: Prompt,
    tools: readonly string[],
  ) => StreamResult | readonly Call[] | string,
) {
  let count = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      const next = script(
        readPrompt(prompt),
        prompt,
        (tools ?? []).map((tool) => tool.name),
      );
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

/** Workflow tool run ids so far. Tests share one world, so each excludes the runs before it. */
async function workflowToolRunIds(): Promise<string[]> {
  const runs = await (
    await getWorld()
  ).runs.list({
    workflowName: workflowToolRunWorkflowReference.workflowId,
    pagination: { limit: 100 },
    resolveData: "none",
  });
  return runs.data.map((run) => run.runId);
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

/** A tool behind a sign-in of its own, named after it: it runs once its callback arrives. */
function signedInTool(name: string, approval?: true): ToolSpec {
  let connected = false;
  const auth: ToolAuthProvider = {
    principalType: "user",
    async getToken() {
      if (!connected) throw new ConnectionAuthorizationRequiredError(name);
      return { token: `${name}-token` };
    },
    async startAuthorization({ callbackUrl }) {
      return { challenge: { url: `https://idp.example/authorize?callback=${callbackUrl}` } };
    },
    async completeAuthorization() {
      connected = true;
      return { token: `${name}-token` };
    },
  };
  return {
    approval,
    execute: async (_input, ctx) => {
      await ctx.getToken(auth, { authKey: name });
      return { ran: name };
    },
    name,
  };
}

interface ToolSpec {
  readonly name: string;
  readonly approval?: boolean;
  readonly allowOtherResponders?: boolean;
  readonly response?: ApprovalResponsePolicy;
  readonly inputSchema?: z.ZodType;
  readonly execute?: (input: unknown, ctx: ToolContext) => unknown;
  /** A `"use workflow"` body from the test fixtures, which makes this a workflow tool. */
  readonly workflow?: (...args: never[]) => unknown;
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
  readonly send: (
    message: string,
    auth?: SessionAuthContext,
    turnPolicy?: "queue" | "steer",
  ) => Promise<void>;
  readonly forward: (callId: string, message: string) => Promise<void>;
  readonly answer: (
    interactionId: string | readonly string[],
    optionId: string,
    auth?: SessionAuthContext,
    fields?: Omit<DeliverPayload, "answers">,
  ) => Promise<string>;
  readonly answerAndSend: (interactionId: string, message: string) => Promise<string>;
  /** Completes the sign-ins `interactionIds` in one callback delivery, as their providers do. */
  readonly signIn: (interactionIds: readonly string[]) => Promise<void>;
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
    readonly model: LanguageModel;
    readonly modelCallsPerStep?: number;
    readonly hooks?: Readonly<Record<string, HookDefinition>>;
    /** Other agent files, by their path under `agent/`. */
    readonly modules?: Readonly<Record<string, unknown>>;
    readonly parent?: SessionParent;
    readonly sessionUsage?: SessionUsageLimit;
    /** Framework tools the agent disables, such as `agent`. */
    readonly disabledTools?: readonly string[];
  },
  body: (session: Session) => Promise<void>,
) {
  const ran: string[] = [];
  const heard = await hearInstrumentation(name);
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model: options.model, modelContextWindowTokens: 200_000 })),
        ...(options.modelCallsPerStep !== undefined && {
          experimental: { workflow: { modelCallsPerStep: options.modelCallsPerStep } },
        }),
        ...(options.sessionUsage !== undefined && {
          limits: { sessionUsage: options.sessionUsage },
        }),
      }),
      name,
    },
    modules: [
      ...Object.entries(options.hooks ?? {}).map(([slug, hook]) => ({
        loadNamespace: async () => ({ default: hook }),
        logicalPath: `hooks/${slug}.ts`,
      })),
      ...Object.entries(options.modules ?? {}).map(([logicalPath, definition]) => ({
        loadNamespace: async () => ({ default: definition }),
        logicalPath,
      })),
      ...(options.disabledTools ?? []).map((name) => ({
        loadNamespace: async () => ({ default: disableTool() }),
        logicalPath: `tools/${name}.ts`,
      })),
      ...options.tools.map((tool) => ({
        loadNamespace: async () => ({
          default: tool.workflow
            ? defineWorkflowTool({
                description: `Run ${tool.name}.`,
                execute: tool.workflow as WorkflowExecuteToolDefinition["execute"],
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
                        ...(tool.response !== undefined && { response: tool.response }),
                      }
                    : undefined,
                description: `Run ${tool.name}.`,
                execute: async (input, ctx) => {
                  ran.push(tool.name);
                  return tool.execute === undefined
                    ? { ran: tool.name }
                    : await tool.execute(input, ctx);
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
        async answer(interactionId, optionId, auth = ALICE, fields = {}) {
          const interactionIds =
            typeof interactionId === "string" ? [interactionId] : interactionId;
          const delivery = createChannelDeliveryMetadata({
            channelKind: "http",
            channelName: "test",
          });
          await resumeHook(commandInbox, {
            auth,
            kind: "send",
            delivery,
            payload: {
              ...fields,
              answers: interactionIds.map((interactionId) => ({ interactionId, optionId })),
            },
          });
          return delivery.deliveryId;
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
        async signIn(interactionIds) {
          const connections = new Map(
            ofType(events, "interaction.opened").map((event) => [
              event.data.interactionId,
              event.data.request.signIn?.name,
            ]),
          );
          await resumeHook(commandInbox, {
            kind: "authorization-callback",
            payloads: interactionIds.map((attemptId) => ({
              authorizationCallback: {
                attemptId,
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: connections.get(attemptId),
              },
            })),
          });
        },
        async send(message, auth = ALICE, turnPolicy) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { message },
            ...(turnPolicy !== undefined && { turnPolicy }),
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

/** Whether a task's result has reached the model. */
const readsTaskResult = (raw: Prompt) => JSON.stringify(raw).includes("<task_result id=");

/** The id of the latest task a receipt in the prompt names. */
const receiptTaskId = (raw: Prompt) =>
  [...JSON.stringify(raw).matchAll(/Started task ([\w-]+)\./gu)].at(-1)?.[1];

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

  // A workflow tool's question sent just before a cancel stopped its run can reach the session
  // after the turn settled. Nobody can answer it then, so the next message must start a turn.
  it("drops a workflow tool's question that arrives after its turn was cancelled", async () => {
    const earlierRuns = await workflowToolRunIds();
    const { events } = await withSession(
      "edge-cancel-late-workflow-question",
      {
        message: "Prepare the deploy.",
        model: scriptedModel(({ said }) =>
          said("Prepare") ? [{ toolName: "prepare", toolCallId: "call_prepare" }] : "Ready.",
        ),
        tools: [{ name: "prepare", workflow: holdUntilAbortedWorkflow }],
      },
      async (session) => {
        await session.until("started", (event) => event.type === "call.started");
        await session.control("cancel");
        await session.until("cancelled", (event) => event.type === "turn.settled");
        const runIds = (await workflowToolRunIds()).filter((id) => !earlierRuns.includes(id));
        expect(runIds).toHaveLength(1);
        await waitForOwnerGate(
          resumeHook(sessionInboxHookToken(`http:edge-cancel-late-workflow-question`), {
            kind: "request",
            from: {
              callId: "call_prepare",
              input: {},
              runId: runIds[0]!,
              sequence: 0,
              stepIndex: 0,
              toolName: "prepare",
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
        await session.send("Next turn.");
        await session.next("next turn");
        // A proxied answer to the stopped run's question would fail the session instead.
        expect(ofType(session.events(), "session.ended")).toEqual([]);
      },
    );

    expect(settlements(events)).toEqual(["call_prepare:interrupted"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    expect(ofType(events, "interaction.opened")).toEqual([]);
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
      { channel: "subagent" },
      { channel: "http" },
      { channel: "subagent" },
    ]);
    expect(received.map((delivery) => [delivery.turnId, delivery.outcome])).toEqual([
      ["turn_0", "handled"],
      ["turn_0", "handled"],
      ["turn_0", "handled"],
    ]);
  });

  it("reads messages from two other people before the model answers, and names each sender", async () => {
    const started = gate();
    const release = gate();
    const prompts: string[] = [];
    const { events } = await withSession(
      "edge-two-people-steer",
      {
        message: "Prepare the review.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          prompts.push(prompt);
          return prompt.includes("Ready.") ? "Review prepared." : [{ toolName: "prepare_review" }];
        }),
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
          await session.send("Bob's note.", BOB);
          await session.send("Carol's note.", { ...ALICE, principalId: "carol" });
        } finally {
          release.open();
        }
        await session.until("done", (event) => event.type === "turn.settled");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    // The model ran twice: once to call the tool, and once after it had read both notes.
    expect(prompts).toHaveLength(2);
    const [, answered] = prompts;
    expect(answered).toContain("Bob's note.");
    expect(answered).toContain("Carol's note.");
    // The prompt is serialized as JSON, so the quotes around each id arrive escaped.
    expect(answered).toContain(
      String.raw`It is from \"bob\". The message before it was from \"alice\".`,
    );
    expect(answered).toContain(
      String.raw`It is from \"carol\". The message before it was from \"bob\".`,
    );
  });

  it.each([
    [
      "another person's typed approve as a message, never as the caller's answer",
      BOB,
      ["Waiting for Alice.", "Deployed."],
    ],
    ["the caller's typed approve as the answer it stands for", ALICE, ["Deployed."]],
  ] as const)("reads %s", async (_label, typist, replies) => {
    const { events, ran } = await withSession(
      `edge-typed-approve-${typist.principalId}`,
      {
        message: "Deploy it.",
        model: scriptedModel(({ results, said }, raw) => {
          if (readsTaskResult(raw) || results.length > 0) return "Deployed.";
          return said("approve")
            ? "Waiting for Alice."
            : [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        // The turn is parked on Alice's open approval when the text arrives.
        await session.send("approve", typist);
        const read = await session.until(
          "the text is read",
          (event) => event.type === "turn.paused" || event.type === "turn.settled",
        );
        if (typist === BOB) {
          // Bob's text joins the turn as a message, and the approval waits as a task.
          expect(ofType(read, "interaction.settled")).toEqual([]);
          await session.answer(session.approvals()[0]!, "approve");
          await session.until("done", (event) => event.type === "turn.settled");
        }
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "content.completed").map((event) => event.data.value)).toEqual(replies);
    // Only Alice's answer was submitted: Bob's text submitted none.
    expect(ofType(events, "response.submitted")).toHaveLength(1);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("keeps the last sender through a turn that a hook's continuation starts", async () => {
    const started = gate();
    const release = gate();
    const senders: (string | undefined)[] = [];
    let continued = false;
    const { events } = await withSession(
      "edge-continuation-keeps-sender",
      {
        hooks: {
          keepGoing: defineHook({
            events: {
              "turn.settled"(_event, ctx) {
                if (continued) return;
                continued = true;
                ctx.continue("Keep going.");
              },
            },
          }),
        },
        message: "Prepare the review.",
        model: scriptedModel(({ results, said }, raw) => {
          if (said("Keep going")) return results.length === 0 ? [{ toolName: "who" }] : "Done.";
          return JSON.stringify(raw).includes("Ready.")
            ? "Review prepared."
            : [{ toolName: "prepare_review" }];
        }),
        tools: [
          {
            name: "prepare_review",
            execute: async () => {
              started.open();
              await release.wait;
              return "Ready.";
            },
          },
          {
            name: "who",
            execute: (_input, ctx) => {
              senders.push(ctx.session.auth.sender?.principalId);
              return "Recorded.";
            },
          },
        ],
      },
      async (session) => {
        await started.wait;
        try {
          await session.send("Bob's note.", BOB);
        } finally {
          release.open();
        }
        await session.until(
          "the continued turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    // The continuation speaks for no one: Bob is still the last person who spoke.
    expect(senders).toEqual(["bob"]);
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

  // What Bob says in Alice's turn doesn't reach a memory scope of Alice's own.
  it("saves nothing of a turn Bob joined to Alice's own memory", async () => {
    const started = gate();
    const release = gate();
    const captured: string[] = [];
    const { events } = await withSession(
      "edge-memory-own",
      {
        message: "Look up the first thing.",
        model: scriptedModel(({ results }) =>
          results.length === 0 ? [{ toolName: "lookup" }] : "Done.",
        ),
        modules: {
          "memory/notes.ts": defineMemory({
            provider: {
              capture: {
                "turn.completed": ({ memory, turn }) =>
                  void captured.push(`${String(memory.scope.value)}:${JSON.stringify(turn.input)}`),
              },
              recall: { "turn.started": () => null },
            },
            scope: (ctx) => ctx.session.auth.current?.principalId ?? null,
          }),
        },
        tools: [
          {
            name: "lookup",
            execute: async () => {
              started.open();
              await release.wait;
              return "Found.";
            },
          },
        ],
      },
      async (session) => {
        await started.wait;
        try {
          await session.send("Use staging instead.", BOB);
        } finally {
          release.open();
        }
        await session.next("the turn Bob joined");
        await session.send("Look up the second thing.");
        await session.next("Alice's next turn");
        await vi.waitFor(() => expect(captured.join()).toContain("second thing"), {
          timeout: 10_000,
        });
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    expect(captured).toEqual([expect.stringMatching(/^alice:.*second thing/u)]);
  });
});

describe("approvals off the happy path", () => {
  const deployModel = () =>
    scriptedModel(({ results, said }) => {
      if (said("Never mind")) return "Okay, stopping.";
      if (results.length > 0) return `Deploy finished: ${JSON.stringify(results[0]?.output)}`;
      // A stale answer reaches the model as the person's text, naming the request it answered.
      // An answer to a request the session never made: the model asks for the deploy again.
      if (said("interaction_missing")) return [{ toolName: "deploy", toolCallId: "call_deploy" }];
      if (said("requestId")) return "That was already done.";
      return [{ toolName: "deploy", toolCallId: "call_deploy" }];
    });
  const deployTools: ToolSpec[] = [{ approval: true, name: "deploy" }];

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

  it("takes another person's answer and the message beside it into the turn it resumes", async () => {
    let messageId = "";
    const { events, ran } = await withSession(
      "edge-answer-with-message",
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
        await session.next("the approved turn reads Bob's message");
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    expect(
      events
        .filter(
          (event) =>
            (event.type === "delivery.admitted" ||
              event.type === "delivery.consumed" ||
              event.type === "delivery.settled") &&
            event.data.deliveryId === messageId,
        )
        .map((event) => event.type),
    ).toEqual(["delivery.admitted", "delivery.consumed", "delivery.settled"]);
    expect(ofType(events, "response.submitted").map((event) => event.data.deliveryId)).toEqual([
      messageId,
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

  it("reads an answer to a request it doesn't know as a message, and the open approval stays open", async () => {
    const { events, ran } = await withSession(
      "edge-answer-nothing",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          if (readsTaskResult(raw)) return "Deploy finished.";
          if (said("interaction_missing")) return "That request isn't open.";
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: deployTools,
      },
      async (session) => {
        await session.next("asks");
        await session.answer("interaction_missing", "approve");
        await session.until("the approval still waits", (event) => event.type === "turn.paused");
        await session.answer(session.approvals()[0]!, "approve");
        await session.until("approved", (event) => event.type === "turn.settled");
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(settlements(events)).toEqual(["call_deploy:completed"]);
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

  it("pauses on approvals asked after a message, beside the one that waits as a task", async () => {
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
          return event.type === "turn.paused" && opened.size === 2;
        });
      },
    );
    // The answered approval ran with the message, and the other still waits beside the new ones.
    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.opened")).toHaveLength(4);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(ofType(events, "turn.paused").at(-1)?.data.awaiting).toHaveLength(3);
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

  it("lets the model drop a call that waits as a task, and the call never runs", async () => {
    const prompts: string[] = [];
    const { events, ran } = await withSession(
      "edge-approval-then-message",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          prompts.push(JSON.stringify(raw));
          if (JSON.stringify(raw).includes("it won't report back")) return "Okay, stopping.";
          if (said("Never mind"))
            return [
              {
                input: { taskId: receiptTaskId(raw) },
                toolCallId: "call_cancel",
                toolName: "eve__task_cancel",
              },
            ];
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: deployTools,
      },
      async (session) => {
        await session.next("asks");
        await session.send("Never mind, don't deploy.");
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    expect(prompts[1]).toContain("It waits for a person to approve it");
    expect(ran).toEqual([]);
    expect(
      ofType(events, "interaction.settled").map((event) => [event.data.outcome, event.data.reason]),
    ).toEqual([["withdrawn", "The model dropped this call with eve__task_cancel before it ran."]]);
    expect(
      ofType(events, "call.settled")
        .filter((event) => event.data.callId === "call_deploy")
        .map((event) => [event.data.outcome, event.data.reason]),
    ).toEqual([["interrupted", "task-cancel"]]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
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

describe("calls that wait on a person as tasks", () => {
  it("runs an approved call as its own tool result when no message arrived meanwhile", async () => {
    const prompts: string[] = [];
    const { events, ran } = await withSession(
      "edge-wait-no-message",
      {
        message: "Deploy it.",
        model: scriptedModel(({ results }, raw) => {
          prompts.push(JSON.stringify(raw));
          return results.length > 0
            ? "Deployed."
            : [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        await session.answer(session.approvals()[0]!, "approve");
        await session.next("approved");
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(prompts.at(-1)).toContain('"toolCallId":"call_deploy","toolName":"deploy","output"');
    expect(prompts.at(-1)).not.toContain("It waits for a person");
    expect(prompts.at(-1)).not.toContain("<task_result id=");
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("reads another person's message with the response's results and receipts, then each answer's result", async () => {
    const prompts: string[] = [];
    const { events, ran } = await withSession(
      "edge-wait-joins",
      {
        message: "Read the notes, then deploy and publish.",
        model: scriptedModel(({ said }, raw) => {
          prompts.push(JSON.stringify(raw));
          if (said("Bob's aside")) return "Noted, Bob.";
          if (readsTaskResult(raw)) return "Both settled.";
          return [
            { toolName: "read_notes", toolCallId: "call_notes" },
            { toolName: "deploy", toolCallId: "call_deploy" },
            { toolName: "publish", toolCallId: "call_publish" },
          ];
        }),
        tools: [
          { execute: () => "The notes say ship it.", name: "read_notes" },
          { approval: true, name: "deploy" },
          { approval: true, name: "publish" },
        ],
      },
      async (session) => {
        await session.next("asks for both approvals");
        const [deploy, publish] = session.approvals();
        await session.send("Bob's aside.", BOB);
        await session.until("both wait as tasks", (event) => event.type === "turn.paused");
        expect(ofType(session.events(), "interaction.settled")).toEqual([]);
        await session.answer(deploy!, "approve");
        await session.until("deploy's result", (event) => event.type === "turn.paused");
        await session.answer(publish!, "deny");
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    // The model read Bob's message after the whole response: read_notes' real result, a receipt
    // for each waiting call, and the [Tasks] note naming what each waits on.
    const joined = prompts.find((prompt) => prompt.includes("Bob's aside"))!;
    expect(joined).toContain("The notes say ship it.");
    expect(joined.match(/It waits for a person to approve it/gu)).toHaveLength(2);
    expect(joined).toMatch(/\[Tasks\][^\]]*tool=\\"deploy\\" status=\\"awaiting-approval\\"/u);
    expect(joined).toMatch(/\[Tasks\][^\]]*tool=\\"publish\\" status=\\"awaiting-approval\\"/u);
    expect(joined.indexOf("The notes say ship it.")).toBeLessThan(joined.indexOf("Bob's aside"));
    // Each answer's result arrived as its task's result, never as a second tool result.
    const results = prompts.at(-1)!;
    expect(results).toMatch(
      /<task_result id=\\"deploy-[\w]+\\" tool=\\"deploy\\" status=\\"completed\\">/u,
    );
    expect(results).toMatch(
      /<task_result id=\\"publish-[\w]+\\" tool=\\"publish\\" status=\\"failed\\">Tool execution was denied. The call didn't run./u,
    );
    expect(results.match(/"toolCallId":"call_deploy","toolName":"deploy","output"/gu)).toHaveLength(
      1,
    );
    expect(ran).toEqual(["read_notes", "deploy"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
      "declined",
    ]);
    expect(settlements(events)).toEqual([
      "call_notes:completed",
      "call_deploy:completed",
      "call_publish:rejected",
    ]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs an approval answered with the message before the model reads it, while its batch-mate waits", async () => {
    const prompts: string[] = [];
    const { ran } = await withSession(
      "edge-wait-answered-mate",
      {
        message: "Deploy and publish.",
        model: scriptedModel(({ said }, raw) => {
          prompts.push(JSON.stringify(raw));
          if (said("Publish only")) return "Published; deploy waits.";
          return [
            { toolName: "deploy", toolCallId: "call_deploy" },
            { toolName: "publish", toolCallId: "call_publish" },
          ];
        }),
        tools: [
          { approval: true, name: "deploy" },
          { approval: true, name: "publish" },
        ],
      },
      async (session) => {
        await session.next("asks for both approvals");
        const [, publish] = session.approvals();
        await session.answer(publish!, "approve", ALICE, { message: "Publish only for now." });
        await session.until("deploy waits", (event) => event.type === "turn.paused");
      },
    );

    expect(ran).toEqual(["publish"]);
    const joined = prompts.find((prompt) => prompt.includes("Publish only"))!;
    expect(joined).toContain(
      '"toolName":"publish","output":{"type":"json","value":{"ran":"publish"}}',
    );
    expect(joined.match(/It waits for a person to approve it/gu)).toHaveLength(1);
  });

  it("holds the turn while a call waits as a task, and cancelling the turn withdraws its request", async () => {
    const prompts: string[] = [];
    const { events, ran } = await withSession(
      "edge-wait-holds",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          prompts.push(JSON.stringify(raw));
          if (said("Bob's aside")) return "Noted.";
          // The late answer reads as the person's words, naming the request it answered.
          if (said("Never mind") || said("requestId")) return "That was already done.";
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.send("Bob's aside.", BOB);
        // The model replied, and the turn waits on the approval rather than ending.
        await session.until("the approval waits", (event) => event.type === "turn.paused");
        expect(ofType(session.events(), "turn.settled")).toEqual([]);
        await session.control("cancel");
        await session.until("cancelled", (event) => event.type === "turn.settled");
        // One delivery, so the late answer and the message start one turn together.
        await session.answer(approval!, "approve", ALICE, { message: "Never mind, how are you?" });
        await session.until(
          "next turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
      },
    );

    expect(ran).toEqual([]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "interrupted",
    ]);
    expect(settlements(events)).toEqual(["call_deploy:interrupted"]);
    // The stopped call's task never reports into the next turn.
    expect(prompts.at(-1)).toContain("Never mind");
    expect(prompts.at(-1)).not.toContain("<task_result id=");
  });

  it("stops a waiting call when its turn fails, and its task never reports", async () => {
    const prompts: string[] = [];
    const { events, ran } = await withSession(
      "edge-wait-failed-turn",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          prompts.push(JSON.stringify(raw));
          if (said("Hello again")) return "Hello.";
          // The step that reads Bob's message fails after the call starts waiting as a task.
          if (said("Bob's aside"))
            throw Object.assign(new Error("Payment required"), { statusCode: 402 });
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        await session.send("Bob's aside.", BOB);
        await session.until("the turn fails", (event) => event.type === "turn.settled");
        await session.send("Hello again.");
        await session.until(
          "next turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:failed", "turn_1:completed"]);
    expect(ran).toEqual([]);
    expect(prompts.at(-1)).toContain("Hello again");
    expect(prompts.at(-1)).not.toContain("<task_result id=");
  });

  it("refuses another person's press on a waiting call's approval, waking no model call", async () => {
    let modelCalls = 0;
    const { events, ran } = await withSession(
      "edge-wait-refused-press",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          modelCalls += 1;
          if (readsTaskResult(raw)) return "Deployed.";
          if (said("Bob's aside")) return [{ toolName: "eve__task_wait", toolCallId: "call_wait" }];
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.send("Bob's aside.", BOB);
        // The model parks the turn on `eve__task_wait` until the call's task reports.
        await session.until(
          "the model waits",
          (event) =>
            event.type === "call.requested" && event.data.capability.name === "eve__task_wait",
        );
        // Only Alice may answer her call's approval, even while it waits as a task.
        await session.answer(approval!, "approve", BOB);
        await session.until(
          "Bob's press is refused",
          (event) => event.type === "response.settled" && event.data.outcome === "refused",
        );
        await session.answer(approval!, "approve");
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    // The model ran to make the call, to wait, and to read its result; Bob's press woke none.
    expect(modelCalls).toBe(3);
    // Bob's press approved nothing; Alice's answer ran the call.
    expect(ofType(events, "response.settled").map((event) => event.data.outcome)).toEqual([
      "refused",
      "applied",
    ]);
    expect(ran).toEqual(["deploy"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs each call that waits on its own sign-in as a task when both callbacks arrive together", async () => {
    const { events } = await withSession(
      "edge-wait-two-sign-ins",
      {
        message: "Read both calendars.",
        model: scriptedModel(({ said }) =>
          said("Read both calendars.")
            ? [
                { toolName: "read_work", toolCallId: "call_work" },
                { toolName: "read_home", toolCallId: "call_home" },
              ]
            : "Done.",
        ),
        tools: [signedInTool("read_work"), signedInTool("read_home")],
      },
      async (session) => {
        const asked = await session.next("asks for both sign-ins");
        const signIns = ofType(asked, "interaction.opened").map(
          (event) => event.data.interactionId,
        );
        expect(signIns).toHaveLength(2);
        await session.send("I'll sign in to both.");
        await session.until("the calls wait as tasks", (event) => event.type === "turn.paused");
        await session.signIn(signIns);
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    expect(settlements(events).sort()).toEqual(["call_home:completed", "call_work:completed"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs a call approved while the model waits once the sign-in it then stops for completes", async () => {
    const { events } = await withSession(
      "edge-wait-approved-sign-in",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          if (readsTaskResult(raw)) return "Deployed.";
          if (said("Wait for it")) return [{ toolName: "eve__task_wait", toolCallId: "call_wait" }];
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [signedInTool("deploy", true)],
      },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.send("Wait for it.");
        await session.until(
          "the model waits",
          (event) =>
            event.type === "call.requested" && event.data.capability.name === "eve__task_wait",
        );
        await session.answer(approval!, "approve");
        const asked = await session.until(
          "the approved call's sign-in",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
        );
        await session.signIn([ofType(asked, "interaction.opened").at(-1)!.data.interactionId]);
        await session.until("settled", (event) => event.type === "turn.settled");
      },
    );

    expect(settlements(events)).toEqual(["call_deploy:completed", "call_wait:completed"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs an older approval's waiting call while a newer approval holds the turn, and pauses again", async () => {
    let modelCalls = 0;
    const { ran } = await withSession(
      "edge-wait-older-approval",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }) => {
          modelCalls += 1;
          if (said("Also publish")) return [{ toolName: "publish", toolCallId: "call_publish" }];
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [
          { approval: true, name: "deploy" },
          { approval: true, name: "publish" },
        ],
      },
      async (session) => {
        await session.next("asks to deploy");
        await session.send("Also publish.");
        await session.until("asks to publish", (event) => event.type === "turn.paused");
        const [deploy] = session.approvals();
        const answered = await session.answer(deploy!, "approve");
        const stage = await session.until(
          "the answer settles",
          (event) => event.type === "delivery.settled" && event.data.deliveryId === answered,
        );
        // Publish's approval still holds the turn, so the model reads deploy's result later.
        expect(
          stage.flatMap((event) => {
            if (event.type === "call.settled")
              return [`${event.data.callId}:${event.data.outcome}`];
            if (event.type === "delivery.settled" && event.data.deliveryId === answered)
              return [`delivery.settled:${event.data.outcome}`];
            return event.type === "turn.paused" || event.type === "model.requested"
              ? [event.type]
              : [];
          }),
        ).toEqual(["call_deploy:completed", "turn.paused", "delivery.settled:awaiting-input"]);
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(modelCalls).toBe(2);
  });

  it("reads a provider-run call's result while a call waits as a task", async () => {
    const lookup: StreamResult = {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            input: "{}",
            providerExecuted: true,
            toolCallId: "srvtoolu_lookup",
            toolName: "web_search",
            type: "tool-call",
          },
          {
            result: { status: "provider-ready" },
            toolCallId: "srvtoolu_lookup",
            toolName: "web_search",
            type: "tool-result",
          },
          { finishReason: { raw: undefined, unified: "tool-calls" }, type: "finish", usage },
        ],
      }) as StreamResult["stream"],
    };
    const { events } = await withSession(
      "edge-wait-provider-result",
      {
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw) => {
          if (!said("Look it up")) return [{ toolName: "deploy", toolCallId: "call_deploy" }];
          return JSON.stringify(raw).includes("provider-ready") ? "The draft is ready." : lookup;
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        await session.send("Look it up with the provider.");
        await session.until("the reply", (event) => event.type === "turn.paused");
      },
    );

    expect(
      ofType(events, "content.completed").flatMap((event) =>
        event.data.phase === "reply" ? [event.data.value] : [],
      ),
    ).toEqual(["The draft is ready."]);
  });

  it("keeps offering the task tools in later turns once a call waited on a person", async () => {
    const offered: (readonly string[])[] = [];
    await withSession(
      "edge-wait-sticky-tools",
      {
        // Without the built-in agent tool, the agent has no tool that starts tasks.
        disabledTools: ["agent"],
        message: "Deploy it.",
        model: scriptedModel(({ said }, raw, tools) => {
          offered.push(tools.filter((name) => name.startsWith("eve__task_")).sort());
          if (said("Thanks")) return "You're welcome.";
          if (readsTaskResult(raw)) return "Deployed.";
          if (said("Bob's aside")) return "Noted.";
          return [{ toolName: "deploy", toolCallId: "call_deploy" }];
        }),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("asks");
        const [approval] = session.approvals();
        await session.send("Bob's aside.", BOB);
        await session.until("the approval waits", (event) => event.type === "turn.paused");
        await session.answer(approval!, "approve");
        await session.until("settled", (event) => event.type === "turn.settled");
        await session.send("Thanks.");
        await session.until(
          "next turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
      },
    );

    // The agent starts no tasks itself. The task tools arrive with the first waiting call and
    // stay after it ends, so later requests keep the same tools.
    const taskTools = ["eve__task_cancel", "eve__task_wait"];
    expect(offered).toEqual([[], taskTools, taskTools, taskTools]);
  });

  it.each(["clear", "reset"] as const)(
    "withdraws a waiting call's request on %s, and nothing reports later",
    async (kind) => {
      const prompts: string[] = [];
      const { events, ran } = await withSession(
        `edge-wait-${kind}`,
        {
          message: "Deploy it.",
          model: scriptedModel(({ said }, raw) => {
            prompts.push(JSON.stringify(raw));
            if (said("Bob's aside") || said("Hello again")) return "Noted.";
            return [{ toolName: "deploy", toolCallId: "call_deploy" }];
          }),
          tools: [{ approval: true, name: "deploy" }],
        },
        async (session) => {
          await session.next("asks");
          const [approval] = session.approvals();
          await session.send("Bob's aside.", BOB);
          await session.until("the approval waits", (event) => event.type === "turn.paused");
          await session.control(kind, kind === "reset" ? { reason: "start over" } : {});
          if (kind === "reset") {
            await session.until("ended", (event) => event.type === "session.ended");
            return;
          }
          await session.until("cleared", (event) => event.type === "turn.settled");
          await session.answer(approval!, "approve");
          await session.send("Hello again.");
          await session.until(
            "next turn",
            (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
          );
        },
      );

      expect(ran).toEqual([]);
      expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
        "interrupted",
      ]);
      expect(settlements(events)).toEqual(["call_deploy:interrupted"]);
      expect(ofType(events, "task.started")).toEqual([]);
      if (kind === "clear") expect(prompts.at(-1)).not.toContain("<task_result id=");
    },
  );
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

  it("drops a refused turn's input from history, and keeps the input of a turn that failed otherwise", async () => {
    let nextPrompt = "";
    const { events } = await withSession(
      "edge-model-refused",
      {
        message: "Alice asks about the release.",
        model: scriptedModel(({ said }, raw) => {
          if (said("pricing")) {
            nextPrompt = JSON.stringify(raw);
            return "Usage-based.";
          }
          if (said("incident report")) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { id: "partial", type: "text-start" },
                  { delta: "The report says", id: "partial", type: "text-delta" },
                  { id: "partial", type: "text-end" },
                  {
                    finishReason: { raw: undefined, unified: "content-filter" },
                    type: "finish",
                    usage,
                  },
                ],
              }) as StreamResult["stream"],
            };
          }
          throw Object.assign(new Error("Payment required"), { statusCode: 402 });
        }),
        tools: [],
      },
      async (session) => {
        await session.next("unpaid");
        await session.send("Alice pastes the incident report.");
        await session.next("filtered");
        await session.send("Alice pastes the incident report again.");
        await session.next("filtered again");
        await session.send("Alice asks about pricing.");
        await session.next("answered");
      },
    );

    expect(turnOutcomes(events)).toEqual([
      "turn_0:failed",
      "turn_1:failed",
      "turn_2:failed",
      "turn_3:completed",
    ]);
    // A failed call keeps the person's message, but a refused one would be refused again.
    expect(nextPrompt).toContain("Alice asks about the release.");
    expect(nextPrompt).toContain("Alice asks about pricing.");
    expect(nextPrompt).not.toContain("incident report");
    expect(nextPrompt).not.toContain("The report says");
    // In their place, the model reads that a turn was refused, once for both.
    expect(nextPrompt.split("The model provider refused a response in this turn")).toHaveLength(2);
  });

  it("keeps the record of a call a refused turn already ran", async () => {
    let sends = 0;
    let nextPrompt = "";
    const { events } = await withSession(
      "edge-refused-after-tool",
      {
        message: "Alice asks to send the March invoice to Bob.",
        model: scriptedModel(({ said, results }, raw) => {
          if (said("did it go out")) {
            nextPrompt = JSON.stringify(raw);
            return "Checking.";
          }
          if (results.length === 0) return [{ toolName: "send_invoice", toolCallId: "call_send" }];
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  finishReason: { raw: undefined, unified: "content-filter" },
                  type: "finish",
                  usage,
                },
              ],
            }) as StreamResult["stream"],
          };
        }),
        tools: [{ name: "send_invoice", execute: () => ({ sent: ++sends }) }],
      },
      async (session) => {
        await session.next("filtered");
        await session.send("Alice asks: did it go out?");
        await session.next("answered");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:failed", "turn_1:completed"]);
    expect(sends).toBe(1);
    // The invoice went out, so the model must still read that it did, though not the request.
    expect(nextPrompt).toContain("call_send");
    expect(nextPrompt).toContain('"sent":1');
    expect(nextPrompt).not.toContain("March invoice");
    // The note takes the input's place, so the call still follows a user message.
    expect(nextPrompt.indexOf("The model provider refused")).toBeLessThan(
      nextPrompt.indexOf("call_send"),
    );
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

  it("fails the turn when OpenAI refuses the prompt for cybersecurity risk, and the session takes the next message", async () => {
    const message = "This content was flagged for possible cybersecurity risk.";
    const refusal = {
      code: "cyber_policy",
      data: { error: { code: "cyber_policy", message, type: "invalid_request" }, type: "error" },
      isRetryable: false,
      message,
      statusCode: 400,
      type: "invalid_request",
    };
    let nextPrompt = "";
    const { events } = await withSession(
      "edge-model-cyber-policy",
      {
        message: "What is a sandbox?",
        model: scriptedModel(({ said }, raw) => {
          if (said("sandbox")) return "An isolated VM.";
          if (said("pricing")) {
            nextPrompt = JSON.stringify(raw);
            return "Usage-based.";
          }
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { error: refusal, type: "error" },
              ],
            }) as StreamResult["stream"],
          };
        }),
        tools: [],
      },
      async (session) => {
        await session.next("answered");
        await session.send("How do I scan my own server for open ports?");
        await session.next("refused");
        await session.send("How does pricing work?");
        await session.next("recovered");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:failed", "turn_2:completed"]);
    expect(ofType(events, "session.ended")).toEqual([]);
    // The refused prompt stays out of the history, so it can't fail the next turn too.
    expect(nextPrompt).toContain("What is a sandbox?");
    expect(nextPrompt).toContain("An isolated VM.");
    expect(nextPrompt).toContain("How does pricing work?");
    expect(nextPrompt).not.toContain("scan my own server");
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
    const earlierRuns = await workflowToolRunIds();
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
        const runIds = (await workflowToolRunIds()).filter((id) => !earlierRuns.includes(id));
        expect(runIds).toHaveLength(1);
        await waitForOwnerGate(
          resumeHook(sessionInboxHookToken(`http:edge-cancel-hung-task`), {
            kind: "request",
            from: {
              callId: "call_agent",
              input: { message: "CHILD: work" },
              runId: runIds[0]!,
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

  const delegatedDeploy = () =>
    scriptedModel((_prompt, raw) => {
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
    });

  it("relays a child's approval to its parent, and answering it there runs the child's call", async () => {
    const { events, ran } = await withSession(
      "edge-child-approval",
      {
        message: "Delegate the deploy.",
        model: delegatedDeploy(),
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

  it("relays a child's request for the caller's identity, which only the caller can approve", async () => {
    const started = gate();
    const release = gate();
    const tokens: string[] = [];
    const { events } = await withSession(
      "edge-child-identity",
      {
        message: "Prepare, then delegate reading the inbox.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const called = (tool: string) => prompt.includes(`"toolName":"${tool}"`);
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:")) {
            return called("read_inbox")
              ? "Child read it."
              : [{ toolName: "read_inbox", toolCallId: "call_child_inbox" }];
          }
          if (!called("prepare")) return [{ toolName: "prepare", toolCallId: "call_prepare" }];
          if (!called("agent"))
            return [
              {
                input: { message: "CHILD: read the inbox." },
                toolName: "agent",
                toolCallId: "call_agent",
              },
            ];
          if (!called("eve__task_wait"))
            return [{ input: {}, toolName: "eve__task_wait", toolCallId: "call_wait" }];
          return "The child is done.";
        }),
        tools: [
          {
            name: "prepare",
            execute: async () => {
              started.open();
              await release.wait;
              return "Prepared.";
            },
          },
          {
            name: "read_inbox",
            execute: async (_input, ctx) => {
              const { token } = await ctx.getToken({
                getToken: async ({ principal }) => ({
                  token: `token:${principal.type === "user" ? principal.id : "app"}`,
                }),
                principalType: "user",
              });
              tokens.push(token);
              return token;
            },
          },
        ],
      },
      async (session) => {
        await started.wait;
        // Bob speaks before the child starts, so the child inherits him as the last to speak.
        try {
          await session.send("Bob's note.", BOB);
        } finally {
          release.open();
        }
        await session.until("the relayed request", (event) => event.type === "turn.paused");
        const [relayed] = session.approvals();
        await session.answer(relayed!, "approve", BOB);
        await session.until(
          "Bob's refused press",
          (event) => event.type === "response.settled" && event.data.outcome === "refused",
        );
        await session.answer(relayed!, "approve", ALICE);
        await session.until("done", (event) => event.type === "turn.settled");
      },
    );

    expect(tokens).toEqual(["token:alice"]);
    const [relayed] = ofType(events, "interaction.opened");
    // The child's own message comes from the agent that delegated as Alice; the request quotes
    // Bob's, from the delegating turn, as what she approves along with the call.
    expect(relayed?.data).toMatchObject({
      audience: { principalIds: ["alice"] },
      origin: { call: { callId: "call_child_inbox", name: "read_inbox" } },
      request: {
        kind: "approval",
        prompt: expect.stringContaining('from "bob", reads: "Bob\'s note."'),
      },
      subject: { callId: "call_agent" },
    });
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  // #5726: Slack sends its responder as `state` with every button answer. That field stays
  // with the parent, and the child still has to admit the answer forwarded to it.
  it("runs the child's call when its relayed approval's answer also carries channel state", async () => {
    const { events, ran } = await withSession(
      "edge-child-approval-state",
      {
        message: "Delegate the deploy.",
        model: delegatedDeploy(),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("relayed approval pause");
        await session.answer(session.approvals()[0]!, "approve", ALICE, {
          state: { responder: "U123" },
        });
        await session.until(
          "the parent's turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(
      ofType(events, "call.settled").find((event) => event.data.callId === "call_agent")?.data,
    ).toMatchObject({ outcome: "completed", output: "Child deployed." });
  });

  // What every session, child sessions included, records about its deliveries and answers.
  const observeReceipts = () => {
    const seen: { session: string; type: string; data: Record<string, unknown> }[] = [];
    const record = (event: { type: string; data: object }, ctx: { session: { id: string } }) =>
      void seen.push({ data: { ...event.data }, session: ctx.session.id, type: event.type });
    const hook = defineHook({
      events: {
        "delivery.admitted": record,
        "delivery.settled": record,
        "response.admitted": record,
        "response.settled": record,
        "response.submitted": record,
      },
    });
    const of = (session: string, type: string) =>
      seen.filter((entry) => entry.session === session && entry.type === type);
    return { hooks: { receipts: hook }, of, seen };
  };
  const childSessions = (events: readonly SessionStreamEvent[]) =>
    ofType(events, "child.opened").map((event) => event.data.sessionId);
  const principal = (auth: SessionAuthContext | null | undefined) =>
    auth == null
      ? null
      : {
          authenticator: auth.authenticator,
          issuer: auth.issuer,
          principalId: auth.principalId,
          principalType: auth.principalType,
        };

  // Without a response policy only the requester answers; the answer's channel state keeps the
  // payload split, so the refusal happens in the child that admits its share.
  it("refuses another person's relayed approval that carries channel state, and keeps the child waiting", async () => {
    const receipts = observeReceipts();
    const callers: unknown[] = [];
    let bobAnswer = "";
    let aliceAnswer = "";
    const { events, ran } = await withSession(
      "edge-child-approval-state-refused",
      {
        hooks: receipts.hooks,
        message: "Delegate the deploy.",
        model: delegatedDeploy(),
        tools: [
          {
            approval: true,
            execute: (_input, ctx) => void callers.push(principal(ctx.session.auth.current)),
            name: "deploy",
          },
        ],
      },
      async (session) => {
        await session.next("relayed approval pause");
        const [child] = childSessions(session.events());
        bobAnswer = await session.answer(session.approvals()[0]!, "approve", BOB, {
          state: { responder: "U_BOB" },
        });
        await vi.waitFor(
          () =>
            expect(receipts.of(child!, "response.settled").map(({ data }) => data.outcome)).toEqual(
              ["refused"],
            ),
          { timeout: 20_000 },
        );
        expect(callers).toEqual([]);
        aliceAnswer = await session.answer(session.approvals()[0]!, "approve", ALICE, {
          state: { responder: "U_ALICE" },
        });
        await session.until(
          "the parent's turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(callers).toEqual([principal(ALICE)]);
    const [child] = childSessions(events);
    expect(receipts.of(child!, "response.settled").map(({ data }) => data.outcome)).toEqual([
      "refused",
      "applied",
    ]);
    // Each answer reaches the child as a delivery of its own, under the person who sent it.
    const receiptOf = (type: string, deliveryId: string) =>
      receipts.of(child!, type).find(({ data }) => data.deliveryId === deliveryId)?.data;
    expect(
      [bobAnswer, aliceAnswer].map((deliveryId) => [
        (receiptOf("delivery.admitted", deliveryId)?.principal as { id: string } | undefined)?.id,
        receiptOf("delivery.settled", deliveryId)?.outcome,
      ]),
    ).toEqual([
      ["bob", "refused"],
      ["alice", "handled"],
    ]);
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
    ]);
    expect(
      ofType(events, "call.settled").find((event) => event.data.callId === "call_agent")?.data,
    ).toMatchObject({ outcome: "completed", output: "Child deployed." });
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
  });

  it("runs the child's call as its caller while the policy and the call see the approving responder", async () => {
    const SLACK_BOB = {
      attributes: {},
      authenticator: "slack",
      issuer: "T_ACME",
      principalId: "U_BOB",
      principalType: "user" as const,
    };
    const policySaw: unknown[] = [];
    const callSaw: unknown[] = [];
    const { ran } = await withSession(
      "edge-child-approval-state-responder",
      {
        message: "Delegate the deploy.",
        model: delegatedDeploy(),
        tools: [
          {
            approval: true,
            execute: (_input, ctx) =>
              void callSaw.push({
                caller: principal(ctx.session.auth.current),
                responder: principal(ctx.approval?.responder),
              }),
            name: "deploy",
            response: ({ request, response }) => {
              policySaw.push({
                requester: principal(request.principal),
                responder: principal(response.principal),
              });
              return response.principal.principalId === "U_BOB"
                ? { status: "allowed" }
                : { reason: "Only Bob approves deploys.", status: "rejected" };
            },
          },
        ],
      },
      async (session) => {
        await session.next("relayed approval pause");
        await session.answer(session.approvals()[0]!, "approve", SLACK_BOB, {
          state: { responder: "U_BOB" },
        });
        await session.until(
          "the parent's turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(policySaw).toEqual([{ requester: principal(ALICE), responder: principal(SLACK_BOB) }]);
    expect(callSaw).toEqual([{ caller: principal(ALICE), responder: principal(SLACK_BOB) }]);
  });

  // The parent delegates two deploys, each behind an approval in its child, and waits for both.
  const twoDelegatedDeploys = () =>
    scriptedModel((_prompt, raw) => {
      const prompt = JSON.stringify(raw);
      const called = (tool: string) => prompt.includes(`"toolName":"${tool}"`);
      const first = raw.find((message) => message.role === "user");
      if (JSON.stringify(first?.content).includes("CHILD:")) {
        return called("deploy")
          ? "Child deployed."
          : [{ toolName: "deploy", toolCallId: "call_child_deploy" }];
      }
      if (!called("agent"))
        return [
          { input: { message: "CHILD: deploy a." }, toolName: "agent", toolCallId: "call_a" },
          { input: { message: "CHILD: deploy b." }, toolName: "agent", toolCallId: "call_b" },
        ];
      // Waits until both children report.
      const reported = prompt.split("Child deployed.").length - 1;
      const waits = prompt.split('"toolName":"eve__task_wait"').length - 1;
      if (reported < 2)
        return [{ input: {}, toolName: "eve__task_wait", toolCallId: `call_wait_${waits}` }];
      return "Both children are done.";
    });

  // One payload that answers two children's prompts gives each child a share. Each share is a
  // delivery of its own in its child, named from the payload's id and the child's place in it,
  // so a retried forward names it the same way and the child admits it once.
  it("forwards one payload's answers to each child that asked, each under its own stable receipt", async () => {
    const receipts = observeReceipts();
    const ranIn: string[] = [];
    let deliveryId = "";
    const { events, ran } = await withSession(
      "edge-children-share-one-answer",
      {
        hooks: receipts.hooks,
        message: "Delegate both deploys.",
        model: twoDelegatedDeploys(),
        tools: [
          {
            approval: true,
            execute: (_input, ctx) => void ranIn.push(ctx.session.id),
            name: "deploy",
          },
        ],
      },
      async (session) => {
        let opened = 0;
        await session.until(
          "both relayed approvals",
          (event) => event.type === "interaction.opened" && ++opened === 2,
        );
        deliveryId = await session.answer(session.approvals(), "approve", ALICE, {
          state: { responder: "U_ALICE" },
        });
        await session.until(
          "the parent's turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
        // A retried forward sends each child its share again under the same receipt. A cancel
        // after it shows when the child has read it.
        for (const child of childSessions(session.events())) {
          const inbox = sessionInboxHookToken(sessionCommandHookToken(child));
          for (const { data } of receipts.of(child, "response.submitted"))
            await resumeHook(inbox, {
              auth: ALICE,
              deliveryMetadata: [
                {
                  channelKind: "http",
                  channelName: "test",
                  deliveryId: data.deliveryId as string,
                  payloadIndex: 0,
                },
              ],
              kind: "deliver",
              payloads: [
                {
                  answers: [{ interactionId: data.interactionId as string, optionId: "approve" }],
                },
              ],
            });
          await resumeHook(inbox, { auth: ALICE, deliveryId: `probe_${child}`, kind: "cancel" });
        }
        await vi.waitFor(
          () =>
            expect(
              receipts.seen.filter(
                ({ data, type }) =>
                  type === "delivery.settled" && String(data.deliveryId).startsWith("probe_"),
              ),
            ).toHaveLength(2),
          { timeout: 20_000 },
        );
      },
    );

    expect(ran).toEqual(["deploy", "deploy"]);
    const children = childSessions(events);
    expect(children).toHaveLength(2);
    expect(ranIn.toSorted()).toEqual(children.toSorted());
    // Each child admitted one share, under its own receipt, and nothing more but the probe.
    const answeredIn = children.map((child) =>
      receipts
        .of(child, "delivery.admitted")
        .map(({ data }) => data.deliveryId as string)
        .filter((id) => id.startsWith(deliveryId)),
    );
    expect(answeredIn.toSorted()).toEqual([[deliveryId], [`${deliveryId}_forwarded_1`]]);
    for (const child of children) {
      const [answer] = receipts.of(child, "response.submitted");
      expect(receipts.of(child, "response.submitted")).toHaveLength(1);
      expect(receipts.of(child, "response.settled").map(({ data }) => data)).toEqual([
        { outcome: "applied", responseId: answer!.data.responseId },
      ]);
      expect(
        receipts
          .of(child, "delivery.settled")
          .find(({ data }) => data.deliveryId === answer!.data.deliveryId)?.data,
      ).toMatchObject({ outcome: "handled" });
    }
    expect(ofType(events, "interaction.settled").map((event) => event.data.outcome)).toEqual([
      "accepted",
      "accepted",
    ]);
    for (const callId of ["call_a", "call_b"])
      expect(
        ofType(events, "call.settled").find((event) => event.data.callId === callId)?.data,
      ).toMatchObject({ outcome: "completed", output: "Child deployed." });
  });

  // A child reports how it settled its share under the share's own id, which this session never
  // recorded. It still credits the outcome to the answer that share came from, not to a later
  // person's answer to the same prompt.
  it("credits a child's refusal of its share to the answer it came from, not a later one", async () => {
    let prompts: string[] = [];
    let bobAnswer = "";
    let aliceAnswer = "";
    const { events, ran } = await withSession(
      "edge-children-share-refused",
      {
        message: "Delegate both deploys.",
        model: twoDelegatedDeploys(),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        let opened = 0;
        await session.until(
          "both relayed approvals",
          (event) => event.type === "interaction.opened" && ++opened === 2,
        );
        // Bob answers both prompts, and Alice answers them too before either child has read
        // Bob's answer. Only Alice, who asked, may approve.
        prompts = session.approvals();
        bobAnswer = await session.answer(prompts, "approve", BOB, {
          state: { responder: "U_BOB" },
        });
        aliceAnswer = await session.answer(prompts, "approve", ALICE, {
          state: { responder: "U_ALICE" },
        });
        await session.until(
          "the parent's turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy", "deploy"]);
    const settled = new Map(
      ofType(events, "response.settled").map(({ data }) => [data.responseId, data.outcome]),
    );
    const answeredBy = new Map([
      [bobAnswer, "bob"],
      [aliceAnswer, "alice"],
    ]);
    const [a, b] = prompts;
    expect(
      ofType(events, "response.submitted")
        .map(({ data }) => [
          answeredBy.get(data.deliveryId),
          data.interactionId === a ? "a" : data.interactionId === b ? "b" : data.interactionId,
          settled.get(data.responseId),
        ])
        .toSorted(),
    ).toEqual([
      ["alice", "a", "applied"],
      ["alice", "b", "applied"],
      ["bob", "a", "refused"],
      ["bob", "b", "refused"],
    ]);
  });

  // #4923: a typed answer to a relayed prompt is a message, so only the turn's
  // own principal may answer it by text; another person's text waits for the
  // turn to end instead of being forwarded to the child under alice's auth.
  it("keeps another principal's typed answer off a relayed prompt, and reads it as a message", async () => {
    const seen: (readonly [string, string, unknown])[] = [];
    const { events, ran } = await withSession(
      "edge-child-foreign-typed-answer",
      {
        hooks: {
          observe: defineHook({
            events: {
              "delivery.consumed"(event, ctx) {
                const text = event.data.parts.find((part) => part.kind === "text")?.text;
                // The child session runs the same hooks; only the parent's deliveries count.
                if (text === undefined || text.includes("CHILD:")) return;
                seen.push([text, event.data.turnId, ctx.session.auth.current?.principalId]);
              },
            },
          }),
        },
        message: "Delegate the deploy.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const called = (tool: string) => prompt.includes(`"toolName":"${tool}"`);
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:")) {
            return called("deploy")
              ? "Child deployed."
              : [{ toolName: "deploy", toolCallId: "call_child_deploy" }];
          }
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
        // Bob may press the child's approve button; his typed text is still his own message.
        tools: [{ allowOtherResponders: true, approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("relayed approval pause");
        // "1" names the first option, approve, as well as its id does.
        await session.send("1", BOB);
        await session.send("approve");
        await session.until(
          "Alice's answer runs the child's call",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    // Only Alice's text answered; Bob's joined her turn as a message while the prompt was open.
    expect(seen).toEqual([
      ["Delegate the deploy.", "turn_0", "alice"],
      ["1", "turn_0", "alice"],
      ["approve", "turn_0", "alice"],
    ]);
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
  it("stops a working task when the conversation is cleared, and its result never arrives", async () => {
    const never = gate();
    const prompts: string[] = [];
    const { events } = await withSession(
      "edge-clear-working-task",
      {
        message: "Delegate the deploy; no need to wait on it.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:"))
            return heldReply("Child deployed.", never.wait);
          prompts.push(prompt);
          if (prompt.includes("What now?")) return "Starting fresh.";
          if (!prompt.includes('"toolName":"agent"'))
            return [
              {
                input: { message: "CHILD: deploy it." },
                toolName: "agent",
                toolCallId: "call_agent",
              },
            ];
          return "The deploy is underway.";
        }),
        tools: [],
      },
      async (session) => {
        await session.until(
          "underway",
          (event) => event.type === "content.completed" && event.data.kind === "text",
        );
        await session.control("clear");
        await session.until("cleared", (event) => event.type === "context.settled");
        await session.send("What now?");
        await session.next("next turn");
      },
    );

    const [ended] = ofType(events, "task.ended");
    expect(ended?.data).toMatchObject({ outcome: "cancelled", reason: "turn-cancelled" });
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    // The cleared conversation's next turn reads only the new message: no task result or note.
    const last = prompts.at(-1)!;
    expect(last).not.toContain("call_agent");
    expect(last).not.toContain(ended!.data.taskId);
  });
  it("drops a finished task's unread result when the conversation is cleared", async () => {
    const never = gate();
    const childReplied = gate();
    const prompts: string[] = [];
    const { events } = await withSession(
      "edge-clear-unread-task-result",
      {
        message: "Delegate the deploy, then keep talking.",
        model: scriptedModel((_prompt, raw) => {
          const prompt = JSON.stringify(raw);
          const first = raw.find((message) => message.role === "user");
          if (JSON.stringify(first?.content).includes("CHILD:")) {
            childReplied.open();
            return "Child deployed.";
          }
          prompts.push(prompt);
          if (prompt.includes("What now?")) return "Starting fresh.";
          if (!prompt.includes('"toolName":"agent"'))
            return [
              {
                input: { message: "CHILD: deploy it." },
                toolName: "agent",
                toolCallId: "call_agent",
              },
            ];
          // The parent keeps generating while the child finishes, so its result stays unread.
          return heldReply("Still", never.wait, "going");
        }),
        tools: [],
      },
      async (session) => {
        await session.until("generating", (event) => event.type === "content.delta");
        await waitForOwnerGate(childReplied.wait, "child reply", session.events);
        // The child's result reaches the parent's inbox while the parent still generates.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await session.control("clear");
        await session.until("cleared", (event) => event.type === "context.settled");
        await session.send("What now?");
        await session.next("next turn");
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
    expect(prompts.at(-1)).not.toContain("Child deployed.");
  });
});

describe("deliveries a child session reads", () => {
  it("are linked to the parent call each serves, a follow-up's own call included", async () => {
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

    const [opened] = ofType(events, "child.opened");
    expect(ofType(events, "child.opened")).toHaveLength(1);
    expect(ofType(events, "child.sent").map((event) => event.data)).toEqual(
      ofType(childEvents, "delivery.admitted").map((event, index) => ({
        callId: ["call_one", "call_two"][index],
        childDeliveryId: event.data.deliveryId,
        sessionId: opened!.data.sessionId,
      })),
    );
    expect(ofType(childEvents, "delivery.admitted")).toHaveLength(2);
  });

  it("replies to the latest forwarded caller when a cancel leaves its queued message unread", async () => {
    const name = "edge-cancel-unread-forward";
    const { events } = await withSession(
      name,
      {
        message: "Review the release notes.",
        parent: {
          callId: "opening",
          rootSessionId: "parent",
          sessionId: "parent",
          turn: { id: "parent-turn", sequence: 1 },
        },
        // The first model call spends past the limit, so the turn waits on a continuation prompt.
        sessionUsage: ({ window }) => window.inputTokens > 0,
        model: scriptedModel(({ results }) =>
          results.length === 0 ? [{ toolName: "review_notes" }] : "Reviewed.",
        ),
        tools: [{ name: "review_notes" }],
      },
      async (session) => {
        await session.until(
          "continuation prompt",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "budget",
        );
        const receiver = await start(receiveDelegatedResultWorkflow, [`${name}:follow-up:reply`]);
        await session.forward("follow-up", "Also check the changelog.");
        await session.until(
          "follow-up queued",
          (event) =>
            event.type === "delivery.admitted" && event.data.deliveryId !== "delivery-initial",
        );
        await session.control("cancel");
        let cancelled = false;
        await session.until("cancelled", (event) => {
          cancelled ||= event.type === "turn.settled";
          return cancelled && event.meta.endOfLine !== false;
        });
        // Turn settlement precedes the reply; let it arrive before the helper cancels its owner.
        await expect(receiver.returnValue).resolves.toMatchObject({
          kind: "runtime-action-result",
        });
      },
    );

    const followUp = ofType(events, "delivery.admitted").find(
      (event) => event.data.deliveryId !== "delivery-initial",
    )!.data.deliveryId;
    expect(ofType(events, "delivery.settled").map((event) => event.data)).toContainEqual(
      expect.objectContaining({ deliveryId: followUp, outcome: "ignored" }),
    );
  });
});

describe("controls between turns", () => {
  it.each(["idle", "during a turn"] as const)(
    "fails a command this owner does not know when %s, so its delivery settles",
    async (when) => {
      const release = gate();
      const { events } = await withSession(
        `edge-unknown-command-${when === "idle" ? "idle" : "turn"}`,
        {
          message: "Say hello.",
          model: scriptedModel(({ said }) =>
            said("Still there?")
              ? "Still here."
              : when === "idle"
                ? "Hello."
                : heldReply("Hello.", release.wait, "Hel"),
          ),
          tools: [],
        },
        async (session) => {
          if (when === "idle") await session.next("first");
          else await session.until("generating", (event) => event.type === "content.delta");
          // A control from a newer eve, such as one an older owner on another deployment reads.
          await session.control("from-the-future" as "clear", { turnId: "turn_0" });
          release.open();
          await session.until(
            "unsupported",
            (event) => event.type === "delivery.settled" && event.data.deliveryId === "control_0",
          );
          await session.send("Still there?");
          await session.until(
            "second",
            (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
          );
        },
      );

      const settled = ofType(events, "delivery.settled").find(
        (event) => event.data.deliveryId === "control_0",
      );
      expect(settled?.data).toEqual({
        deliveryId: "control_0",
        outcome: "failed",
        reason: 'This session does not support the "from-the-future" command.',
      });
      expect(ofType(events, "delivery.admitted")).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            deliveryId: "control_0",
            source: { control: "from-the-future" },
          }),
        }),
      );
      expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:completed"]);
    },
  );

  it.each([1, 4])(
    "keeps summary usage when a context.settled hook cancels with %s model calls per step",
    async (modelCallsPerStep) => {
      let summaries = 0;
      let continuedUsage: number | undefined;
      const model = mockModel(({ messages, toolResults, lastUserMessage }) => {
        if (messages.some((message) => message.text.includes("previous checkpoint"))) {
          summaries += 1;
          return {
            text: "Alice's fern has brown tips and dry soil.",
            usage: { inputTokens: 2_000, outputTokens: 300 },
          };
        }
        if (lastUserMessage?.includes("Should Alice water it more?")) {
          if (toolResults.length > 0) throw new Error("The hook must cancel before another call.");
          return {
            toolCalls: [{ name: "check_soil" }],
            usage: { inputTokens: 200_000, outputTokens: 10 },
          };
        }
        return {
          text: "Brown tips can mean underwatering.",
          usage: { inputTokens: 1_000, outputTokens: 10 },
        };
      });
      const { events, ran } = await withSession(
        `edge-summary-hook-cancel-${modelCallsPerStep}`,
        {
          hooks: {
            stop: defineHook({
              events: {
                "context.settled": (event, ctx) => {
                  if (event.data.kind === "compaction" && event.data.outcome === "completed")
                    ctx.cancel();
                },
              },
            }),
          },
          message: "Alice's fern has brown tips.",
          model: toAiSdkLanguageModel(model),
          modelCallsPerStep,
          sessionUsage: ({ window }) => {
            if (window.inputTokens < 203_000) return false;
            continuedUsage = window.inputTokens;
            return true;
          },
          tools: [{ name: "check_soil" }],
        },
        async (session) => {
          await session.next("first reply");
          await session.send("Should Alice water it more?");
          await session.next("cancelled after summary");
          // A later turn's budget reads the checkpoint, not only the live stream. In the batched
          // case it must retain the cut call's summary spend above the completed tool call.
          await session.send("Bob asks for the next care steps.");
          await session.until(
            "budget after cancellation",
            (event) => event.type === "interaction.opened" && event.data.request.kind === "budget",
          );
        },
      );

      expect(continuedUsage).toBe(203_000);
      expect(ran).toEqual(["check_soil"]);
      expect(summaries).toBe(1);
      expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:cancelled"]);
      expect(ofType(events, "context.settled")).toHaveLength(1);
      const [change] = ofType(events, "context.settled");
      expect(change?.data).toMatchObject({ kind: "compaction", outcome: "completed" });
      const summaryRun = ofType(events, "model.requested").find(
        (event) => "changeId" in event.data.owner,
      );
      expect(summaryRun).toBeDefined();
      expect(ofType(events, "usage.recorded").map((event) => event.data)).toContainEqual(
        expect.objectContaining({
          owner: { runId: summaryRun!.data.runId },
          usage: expect.objectContaining({ inputTokens: 2_000, outputTokens: 300 }),
        }),
      );
      expect(viewOfEvents(events).view.usage.total).toMatchObject({
        inputTokens: 203_000,
        outputTokens: 320,
      });
      expect(ofType(events, "session.ended")).toEqual([]);
    },
  );

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

  it("cancels a turn still generating when the conversation is cleared", async () => {
    const never = gate();
    const prompts: number[] = [];
    const { events } = await withSession(
      "edge-clear-running-turn",
      {
        message: "Write a long story.",
        model: scriptedModel(({ said, users }) => {
          prompts.push(users);
          return said("What now?") ? "Fresh start." : heldReply("Once upon", never.wait, "a");
        }),
        tools: [],
      },
      async (session) => {
        await session.until("generating", (event) => event.type === "content.delta");
        await session.control("clear");
        await session.until("cleared", (event) => event.type === "context.settled");
        await session.send("What now?");
        await session.next("next turn");
      },
    );

    expect(prompts).toEqual([1, 1]);
    expect(turnOutcomes(events)).toEqual(["turn_0:cancelled", "turn_1:completed"]);
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

describe("turns parked on their own prompt", () => {
  // #4923: a turn parked on its continuation prompt is still alice's turn, so
  // bob's message waits for it to end instead of joining it.
  it("keeps another principal's message out of a turn parked on its prompt", async () => {
    const seen: (readonly [string, string, unknown])[] = [];
    const { events } = await withSession(
      "edge-limit-foreign-message",
      {
        hooks: {
          observe: defineHook({
            events: {
              "delivery.consumed"(event, ctx) {
                const text = event.data.parts.find((part) => part.kind === "text")?.text;
                seen.push([
                  text ?? "(answer)",
                  event.data.turnId,
                  ctx.session.auth.current?.principalId,
                ]);
              },
              "turn.settled"(event, ctx) {
                seen.push([event.type, event.data.turnId, ctx.session.auth.current?.principalId]);
              },
            },
          }),
        },
        message: "Hello there",
        model: scriptedModel(() => "Hello."),
        // The first turn spends the whole budget, so the next one parks on the prompt.
        sessionUsage: ({ window }) => window.inputTokens >= 1,
        tools: [],
      },
      async (session) => {
        await session.next("first reply");
        await session.send("keep going please");
        const parked = await session.until(
          "continuation prompt",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "budget",
        );
        const prompt = ofType(parked, "interaction.opened").at(-1)!.data.interactionId;
        seen.length = 0;

        await session.send("bob here", BOB);
        await session.answer(prompt, DENY_OPTION_ID);
        await session.until(
          "declined",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_1",
        );
        // Bob's message runs as his own turn, which parks on its own prompt.
        await session.until(
          "Bob's prompt",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "budget",
        );
      },
    );

    expect(turnOutcomes(events)).toEqual(["turn_0:completed", "turn_1:cancelled"]);
    expect(seen).toEqual([
      ["(answer)", "turn_1", "alice"],
      ["turn.settled", "turn_1", "alice"],
      ["bob here", "turn_2", "bob"],
    ]);
  });

  // Another person's message joins a turn that waits on its own tool approval: the approval
  // waits as a task, and Alice's answer later runs it as her call.
  it("lets another principal's queued message join a turn that waits on its own approval", async () => {
    const seen: (readonly [string, string, unknown, unknown])[] = [];
    const { events, ran } = await withSession(
      "edge-approval-foreign-message",
      {
        hooks: {
          observe: defineHook({
            events: {
              "delivery.consumed"(event, ctx) {
                const text = event.data.parts.find((part) => part.kind === "text")?.text;
                seen.push([
                  text ?? "(answer)",
                  event.data.turnId,
                  ctx.session.auth.current?.principalId,
                  ctx.session.auth.sender?.principalId,
                ]);
              },
              "turn.settled"(event, ctx) {
                seen.push([
                  event.type,
                  event.data.turnId,
                  ctx.session.auth.current?.principalId,
                  ctx.session.auth.sender?.principalId,
                ]);
              },
            },
          }),
        },
        message: "Deploy.",
        // Deploys once in the turn, whoever spoke last.
        model: scriptedModel((_prompt, raw) =>
          JSON.stringify(raw).includes('"toolName":"deploy"')
            ? "Done."
            : [{ toolName: "deploy", toolCallId: "call_a" }],
        ),
        tools: [{ approval: true, name: "deploy" }],
      },
      async (session) => {
        await session.next("the approval");
        const [approval] = session.approvals();
        // The turn can't end until Alice acts, so even a queued message joins it.
        await session.send("bob here", BOB, "queue");
        await session.until(
          "the approval waits as a task",
          (event) => event.type === "turn.paused",
        );
        await session.answer(approval!, "approve");
        await session.until(
          "the approved turn",
          (event) => event.type === "turn.settled" && event.data.turnId === "turn_0",
        );
      },
    );

    expect(ran).toEqual(["deploy"]);
    expect(turnOutcomes(events)).toEqual(["turn_0:completed"]);
    // Bob's message joins Alice's turn at once: she stays its caller, and he is its latest sender.
    expect(seen).toEqual([
      ["Deploy.", "turn_0", "alice", "alice"],
      ["bob here", "turn_0", "alice", "bob"],
      ["(answer)", "turn_0", "alice", "bob"],
      ["turn.settled", "turn_0", "alice", "bob"],
    ]);
  });
});
