import { jsonSchema, type LanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
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
 * Runs a turn whose first response ends with a local call and a server tool call the provider
 * hasn't answered, then serves `later` responses until the turn stops. A `steer` message reaches
 * the turn right after the first step. Returns the contract violations, the server call's facts,
 * and the last message of each request.
 */
async function runLateResult(later: StreamPart[][], options: { readonly steer?: string } = {}) {
  const responses: StreamPart[][] = [
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
    doStream: async () => ({ stream: convertArrayToReadableStream(responses.shift() ?? []) }),
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

  const first = await runStep(session, { message: "List the files and find a weather tool." });
  if (typeof first.next !== "function") throw new TypeError("Expected the turn to continue.");
  let result = await first.next(
    first.session,
    options.steer === undefined ? undefined : { message: options.steer },
  );
  for (let steps = 0; typeof result.next === "function" && steps < 5; steps += 1) {
    result = await result.next(result.session);
  }
  const requests = model.doStreamCalls.map(({ prompt }) => ({
    last: prompt.at(-1),
    system: prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])),
  }));
  return { requests, searchFacts, violations };
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
