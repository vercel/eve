import { APICallError, jsonSchema, type LanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { takeDeferredMessage } from "#harness/hitl/index.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";

// The harness runs outside a workflow body here, where run attributes cannot be written.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

function finish(unified: "stop" | "tool-calls"): StreamPart {
  return { finishReason: { raw: undefined, unified }, type: "finish", usage };
}

const searchId = "srvtoolu_search";
const searchResult: StreamPart = {
  result: { tools: [] },
  toolCallId: searchId,
  toolName: "tool_search_tool_bm25",
  type: "tool-result",
};

/**
 * A harness whose first response ends with a local call and a server tool call the provider
 * hasn't answered, then serves `later` responses; an error fails its model call. Records the
 * contract violations, the server call's facts, and each request's prompt.
 */
function deferredHarness(later: (StreamPart[] | Error)[]) {
  const responses: (StreamPart[] | Error)[] = [
    [
      { input: '{"command":"ls"}', toolCallId: "toolu_bash", toolName: "bash", type: "tool-call" },
      {
        input: '{"query":"weather"}',
        providerExecuted: true,
        toolCallId: searchId,
        toolName: "tool_search_tool_bm25",
        type: "tool-call",
      },
      finish("tool-calls"),
    ],
    ...later,
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = responses.shift() ?? [];
      if (next instanceof Error) throw next;
      return { stream: convertArrayToReadableStream(next) };
    },
  });
  const bash = {
    description: "Run a command",
    execute: async () => ({ stdout: "" }),
    inputSchema: jsonSchema({ type: "object" }),
    name: "bash",
  };
  const checker = createStreamChecker();
  const violations: unknown[] = [];
  const searchFacts: string[] = [];
  let position = 0;
  const runStep = createToolLoopHarness({
    handleEvent: async (publication) => {
      const facts = [...eventsOf(publication)];
      violations.push(...checker.check({ at: "2026-10-21T00:00:00.000Z", facts }, position++));
      for (const fact of facts) {
        if ((fact.data as { callId?: string }).callId === searchId) searchFacts.push(fact.type);
      }
    },
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map([["bash", bash]]),
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "deferred-result" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:deferred-result",
    history: [],
    sessionId: "deferred-result",
  };
  const prompts = () => model.doStreamCalls.map(({ prompt }) => prompt);
  return { prompts, runStep, searchFacts, session, violations };
}

/** Runs steps from `result` until the turn stops. */
async function untilStopped(result: StepResult): Promise<StepResult> {
  for (let steps = 0; typeof result.next === "function" && steps < 5; steps += 1) {
    result = await result.next(result.session);
  }
  return result;
}

const start = "List the files and find a weather tool.";

/**
 * Runs a turn on {@link deferredHarness} until it stops. A `steer` message reaches the turn right
 * after the first step. Returns the contract violations, the server call's facts, and the last
 * message of each request.
 */
async function runLateResult(later: StreamPart[][], options: { readonly steer?: string } = {}) {
  const run = deferredHarness(later);
  const first = await run.runStep(run.session, { message: start });
  if (typeof first.next !== "function") throw new TypeError("Expected the turn to continue.");
  await untilStopped(
    await first.next(
      first.session,
      options.steer === undefined ? undefined : { message: options.steer },
    ),
  );
  const requests = run.prompts().map((prompt) => ({
    last: prompt.at(-1),
    system: prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])),
  }));
  return { requests, searchFacts: run.searchFacts, violations: run.violations };
}

const reply: StreamPart[] = [
  { id: "text", type: "text-start" },
  { delta: "Done.", id: "text", type: "text-delta" },
  { id: "text", type: "text-end" },
  finish("stop"),
];

describe("a provider result that arrives a step late", () => {
  // Anthropic can end a response with a server tool call it hasn't answered yet, beside a local
  // call, and open the next response with that call's result.
  it("settles the call the earlier step introduced", async () => {
    const { searchFacts, violations } = await runLateResult([[searchResult, ...reply]]);

    expect(violations).toEqual([]);
    expect(searchFacts).toEqual(["call.requested", "call.started", "call.settled"]);
  });

  it("settles it once when the step's first attempt fails after the result", async () => {
    const overloaded: StreamPart = {
      error: { message: "Overloaded", type: "overloaded_error" },
      type: "error",
    };
    const { searchFacts, violations } = await runLateResult([
      [searchResult, overloaded],
      [searchResult, ...reply],
    ]);

    expect(violations).toEqual([]);
    expect(searchFacts).toEqual(["call.requested", "call.started", "call.settled"]);
  });
});

// A request that adds anything after the local results, while the server call's result is still
// to come, ends the turn early, and Anthropic rejects it.
describe("input while a provider result is still to come", () => {
  const steer = "Also check whether it covers Lisbon.";
  const localResult = {
    content: [expect.objectContaining({ toolCallId: "toolu_bash" })],
    role: "tool",
  };
  const steered = { content: [{ text: steer, type: "text" }], role: "user" };

  it("holds a steering message until the result arrives", async () => {
    const { requests, violations } = await runLateResult([[searchResult, ...reply], reply], {
      steer,
    });

    expect(violations).toEqual([]);
    expect(requests.map(({ last }) => last)).toEqual([expect.anything(), localResult, steered]);
  });

  // A switched model, or a provider that dropped the call, never sends the result: the next
  // response still moves history past the local results, so the message reaches the one after it.
  it("releases the message after a response without the result", async () => {
    const { requests } = await runLateResult([reply, reply], { steer });

    expect(requests.map(({ last }) => last)).toEqual([expect.anything(), localResult, steered]);
  });

  it("sends an empty-response retry's note as instructions", async () => {
    const { requests } = await runLateResult([[], [searchResult, ...reply]]);

    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual({
      last: localResult,
      system: expect.arrayContaining([expect.stringContaining("was not delivered")]),
    });
  });
});

// A failed or cancelled turn leaves history on the local results with the server call unanswered,
// and its result can't come once anything else follows them. The next request answers the call
// instead, so it reads the person's message first and the provider accepts it.
describe("a provider result that can no longer come", () => {
  const failure = new APICallError({
    isRetryable: false,
    message: "The provider is unavailable.",
    requestBodyValues: {},
    statusCode: 400,
    url: "https://provider.test",
  });
  const followUp = "Alice is back: which files were there?";

  /** Server calls the prompt sends without a result anywhere in it. */
  function danglingServerCalls(
    prompt: ReturnType<ReturnType<typeof deferredHarness>["prompts"]>[number],
  ) {
    const parts = prompt.flatMap(
      (message): { type: string; toolCallId?: string; providerExecuted?: boolean }[] =>
        Array.isArray(message.content) ? message.content : [],
    );
    const answered = new Set(
      parts.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])),
    );
    return parts.filter(
      (part) =>
        part.type === "tool-call" &&
        part.providerExecuted === true &&
        !answered.has(part.toolCallId),
    );
  }

  it("answers it for a new turn instead of holding the message", async () => {
    const run = deferredHarness([failure, reply]);
    const first = await run.runStep(run.session, { message: start });
    if (typeof first.next !== "function") throw new TypeError("Expected the turn to continue.");
    const failed = await untilStopped(await first.next(first.session));

    await untilStopped(await run.runStep(failed.session, { message: followUp }));

    const [, , request] = run.prompts();
    expect(run.prompts()).toHaveLength(3);
    expect(request?.at(-1)).toMatchObject({ content: [{ text: followUp }], role: "user" });
    expect(danglingServerCalls(request!)).toEqual([]);
  });

  // A cancel during the step that waits for the result keeps the held message in history after
  // the local results, as an interrupted step's retry note follows them.
  it("answers it once a message follows the local results", async () => {
    const steer = "Also check whether it covers Lisbon.";
    const run = deferredHarness([failure, reply]);
    const first = await run.runStep(run.session, { message: start });
    if (typeof first.next !== "function") throw new TypeError("Expected the turn to continue.");
    const stopped = await untilStopped(await first.next(first.session, { message: steer }));
    const held = takeDeferredMessage(stopped.session);
    const cancelled = await preserveCancelledTurnMessage(held.session, { message: held.message });

    await untilStopped(await run.runStep(cancelled, { message: followUp }));

    const request = run.prompts().at(-1)!;
    expect(held.message).toBe(steer);
    expect(request.at(-1)).toMatchObject({ content: [{ text: followUp }], role: "user" });
    expect(danglingServerCalls(request)).toEqual([]);
  });
});
