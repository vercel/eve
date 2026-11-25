import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";
import {
  INJECTED,
  type ResponsesBody,
  compactionReply,
  contextOverflowReply,
  fresh,
  functionCallReply,
  isCompactionTrigger,
  kernelFor,
  openaiWithFetch,
  textReply,
  turn,
} from "#internal/testing/openai-responses.js";
import { defaultCompaction, openaiCompaction } from "#public/experimental/compaction/index.js";
import type { CompactionStrategy } from "#shared/compaction-strategy.js";

const run = <T>(fn: () => Promise<T>) => contextStorage.run(new ContextContainer(), fn);

const isTrigger = isCompactionTrigger;

const eager = () =>
  openaiCompaction({ fallback: defaultCompaction({ threshold: 0.02 }), threshold: 0.02 });

const FULL_WINDOW_TOKENS = 4_000;

const dueOn = (
  strategy: CompactionStrategy,
  due: (asked: number) => boolean,
): CompactionStrategy => {
  let asked = 0;
  return async (history, ctx) =>
    await strategy(history, due(++asked) ? { ...ctx, tokens: FULL_WINDOW_TOKENS } : ctx);
};

const item = (body: ResponsesBody) => body.input.find((entry) => entry.type === "compaction");

function anthropicWithFetch(bodies: Record<string, unknown>[]) {
  return createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          content: [{ text: "Noted.", type: "text" }],
          id: "msg_1",
          model: "claude",
          role: "assistant",
          stop_reason: "end_turn",
          type: "message",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    },
  }).messages("claude-sonnet-4-5");
}

function googleWithFetch(bodies: { contents: { parts: unknown[]; role: string }[] }[]) {
  return createGoogleGenerativeAI({
    apiKey: "test",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const chunk = {
        candidates: [
          { content: { parts: [{ text: "Noted." }], role: "model" }, finishReason: "STOP" },
        ],
        usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 10, totalTokenCount: 12 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  })("gemini-2.5-flash");
}

const gatewayUsage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 40, total: 40 },
  outputTokens: { reasoning: undefined, text: 5, total: 5 },
};
const gatewayFinish = {
  finishReason: { raw: undefined, unified: "stop" },
  type: "finish",
  usage: gatewayUsage,
};
const gatewaySse = (parts: readonly Record<string, unknown>[]) =>
  new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
const gatewayText = (text: string) =>
  gatewaySse([
    { type: "stream-start", warnings: [] },
    { id: "t", type: "text-start" },
    { delta: text, id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
    gatewayFinish,
  ]);
const gatewayItem = () =>
  gatewaySse([
    { type: "stream-start", warnings: [] },
    {
      kind: "openai.compaction",
      providerMetadata: {
        openai: { encryptedContent: "ENCRYPTED-STATE", itemId: "cmp_1", type: "compaction" },
      },
      type: "custom",
    },
    gatewayFinish,
  ]);

interface GatewayBody {
  readonly prompt: readonly { readonly content: unknown }[];
  readonly providerOptions?: {
    readonly gateway?: { readonly only?: readonly string[] };
    readonly openai?: { readonly compactionTrigger?: boolean };
  };
}

function gatewayWithFetch(bodies: GatewayBody[], respond: (body: GatewayBody) => Response) {
  return createGateway({
    apiKey: "test",
    baseURL: "https://gateway.test/v4/ai",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as GatewayBody;
      bodies.push(body);
      return respond(body);
    },
  })("openai/gpt-5");
}

const asksToCompact = (body: GatewayBody) =>
  body.providerOptions?.openai?.compactionTrigger === true;

afterEach(() => vi.restoreAllMocks());

describe("openaiCompaction()", () => {
  it("compacts the turn's own request into OpenAI's item, without eve's injected messages", async () => {
    const bodies: ResponsesBody[] = [];

    const session = await run(() =>
      turn(kernelFor(eager(), openaiWithFetch(bodies)), fresh(), "Which sources back the claim?"),
    );

    const [compacting] = bodies;
    expect(compacting!.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(compacting!.store).toBe(false);
    expect(compacting!.tools?.map((tool) => tool.name)).toContain("lookup");
    const sent = JSON.stringify(compacting!.input);
    for (const injected of INJECTED) expect(sent).not.toContain(String(injected.content));
    const kept = session.history.findIndex(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "custom" && part.kind === "openai.compaction"),
    );
    expect(kept).toBeGreaterThanOrEqual(0);
    const before = JSON.stringify(session.history.slice(0, kept));
    for (const injected of INJECTED) expect(before).not.toContain(String(injected.content));
  });

  it("sends OpenAI's item inline, byte for byte, on every request after a compaction and a reload, when the agent sets store: false", async () => {
    const bodies: ResponsesBody[] = [];
    const model = openaiWithFetch(bodies);

    const first = await run(() =>
      turn(kernelFor(eager(), model), fresh(), "Which sources back the claim?"),
    );
    const reloaded = JSON.parse(JSON.stringify(first)) as HarnessSession;
    await run(() => turn(kernelFor(eager(), model), reloaded, "And the second claim?"));

    const afterCompaction = bodies.filter((body) => !isTrigger(body) && item(body) !== undefined);
    expect(afterCompaction.length).toBeGreaterThanOrEqual(2);
    expect(item(afterCompaction[0]!)).toEqual({
      encrypted_content: "ENCRYPTED-STATE",
      id: "cmp_1",
      type: "compaction",
    });
    expect(afterCompaction.every((body) => body.store === false)).toBe(true);
    for (const body of afterCompaction) {
      expect(JSON.stringify(item(body))).toBe(JSON.stringify(item(afterCompaction[0]!)));
      expect(JSON.stringify(body.input)).not.toContain("item_reference");
    }
  });

  it("refers to the item OpenAI kept on every request after a compaction and a reload, with the default openai() settings", async () => {
    const bodies: ResponsesBody[] = [];
    const model = openaiWithFetch(bodies);
    const options = { openaiOptions: {} };

    const first = await run(() =>
      turn(kernelFor(eager(), model, [], options), fresh(), "Which sources back the claim?"),
    );
    const reloaded = JSON.parse(JSON.stringify(first)) as HarnessSession;
    await run(() =>
      turn(kernelFor(eager(), model, [], options), reloaded, "And the second claim?"),
    );

    const [compacting] = bodies;
    expect(compacting!.store).toBeUndefined();
    const afterCompaction = bodies.filter((body) => !isTrigger(body));
    expect(afterCompaction.length).toBeGreaterThanOrEqual(2);
    for (const body of afterCompaction) {
      expect(body.input).toContainEqual({ id: "cmp_1", type: "item_reference" });
      expect(item(body)).toBeUndefined();
    }
  });

  it("compacts again in the same turn once tool results have been added after the item", async () => {
    const bodies: ResponsesBody[] = [];
    let triggers = 0;
    let calls = 0;
    const model = openaiWithFetch(bodies, (body) => {
      if (isTrigger(body)) return compactionReply(`cmp_${++triggers}`, `STATE-${triggers}`);
      return ++calls === 1 ? functionCallReply("call_1") : textReply("Done.");
    });

    const session = await run(() =>
      turn(kernelFor(eager(), model), fresh(), "Which sources back the claim?"),
    );

    expect(triggers).toBe(2);
    const last = bodies.at(-1)!;
    expect(item(last)).toMatchObject({ id: "cmp_2" });
    expect(last.input.filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(session.history.at(-1)).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(session.history.at(-1))).toContain("Done.");
  });

  it("compacts and retries when the turn reaches the window after an earlier compaction", async () => {
    const bodies: ResponsesBody[] = [];
    let triggers = 0;
    let calls = 0;
    const model = openaiWithFetch(bodies, (body) => {
      if (isTrigger(body)) return compactionReply(`cmp_${++triggers}`, `STATE-${triggers}`);
      calls += 1;
      if (calls === 1) return functionCallReply("call_1");
      return calls === 2 ? contextOverflowReply() : textReply("Done.");
    });

    const session = await run(() =>
      turn(
        kernelFor(
          dueOn(openaiCompaction(), (asked) => asked === 1),
          model,
        ),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    expect(triggers).toBe(2);
    expect(item(bodies.at(-1)!)).toMatchObject({ id: "cmp_2" });
    expect(JSON.stringify(session.history.at(-1))).toContain("Done.");
  });

  it("declines to compact when the item is the last thing in the history and nothing was added", async () => {
    const send = vi.fn();
    const history = [
      { content: "Review it.", kind: "user", role: "user" },
      {
        content: [
          {
            kind: "openai.compaction",
            providerOptions: { openai: { encryptedContent: "ENC", itemId: "cmp_1" } },
            type: "custom",
          },
        ],
        role: "assistant",
      },
    ] as const;

    const result = await openaiCompaction()(
      history as never,
      {
        abortSignal: new AbortController().signal,
        call: send,
        model: { contextWindowTokens: 1_000, provider: "openai.responses", modelId: "gpt-5" },
        overflow: false,
        requested: true,
        session: { id: "s" },
        tokens: 5_000,
      } as never,
    );

    expect(result).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("summarizes as text and says why when OpenAI's compaction call fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const bodies: ResponsesBody[] = [];
    const model = openaiWithFetch(bodies, (body) =>
      isTrigger(body)
        ? new Response(JSON.stringify({ error: { message: "compaction is unavailable" } }), {
            headers: { "content-type": "application/json" },
            status: 400,
          })
        : textReply("Summary of the conversation so far."),
    );

    const session = await run(() =>
      turn(kernelFor(eager(), model), fresh(), "Which sources back the claim?"),
    );

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI compaction failed; eve compacts with its fallback instead"),
      expect.objectContaining({ errorName: "AI_APICallError", statusCode: 400 }),
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain("Which sources back the claim?");
    expect(
      session.history.some((message) => "kind" in message && message.kind === "context.compaction"),
    ).toBe(true);
    expect(JSON.stringify(session.history)).not.toContain("openai.compaction");
  });

  it("summarizes as text and says why on a provider other than OpenAI", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: Record<string, unknown>[] = [];

    const session = await run(() =>
      turn(
        kernelFor(
          openaiCompaction({
            fallback: (history) => [
              { content: "Summary:", kind: "context.compaction", role: "user" },
              { content: "Alice's contract was reviewed.", role: "assistant" },
              ...history.slice(-1),
            ],
            threshold: 0.02,
          }),
          anthropicWithFetch(bodies),
        ),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("openaiCompaction() needs an OpenAI model"),
      expect.anything(),
    );
    expect(
      session.history.some((message) => "kind" in message && message.kind === "context.compaction"),
    ).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain("compaction_trigger");
  });

  it("warns, and still sends the request, when a session holding OpenAI's item runs on another provider", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const openaiBodies: ResponsesBody[] = [];
    const first = await run(() =>
      turn(
        kernelFor(eager(), openaiWithFetch(openaiBodies)),
        fresh(),
        "Which sources back the claim?",
      ),
    );
    const anthropicBodies: Record<string, unknown>[] = [];
    const switched = JSON.parse(JSON.stringify(first)) as HarnessSession;

    await run(() =>
      turn(
        kernelFor(async () => undefined, anthropicWithFetch(anthropicBodies)),
        switched,
        "And the second claim?",
      ),
    );

    expect(anthropicBodies.length).toBeGreaterThan(0);
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI compaction record"),
      expect.anything(),
    );
    expect(JSON.stringify(anthropicBodies)).not.toContain("ENCRYPTED-STATE");
  });
  it("leaves the record and any message it empties out of the request when a session switches to Google", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await run(() =>
      turn(kernelFor(eager(), openaiWithFetch([])), fresh(), "Which sources back the claim?"),
    );
    const googleBodies: { contents: { parts: unknown[]; role: string }[] }[] = [];

    await run(() =>
      turn(
        kernelFor(async () => undefined, googleWithFetch(googleBodies)),
        JSON.parse(JSON.stringify(first)) as HarnessSession,
        "And the second claim?",
      ),
    );

    expect(googleBodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(googleBodies)).not.toContain("ENCRYPTED-STATE");
    for (const body of googleBodies) {
      for (const content of body.contents) expect(content.parts.length).toBeGreaterThan(0);
    }
  });

  it('compacts through an AI Gateway "openai/" model, and sends the item it returned on later requests after a reload', async () => {
    const bodies: GatewayBody[] = [];
    const providers: string[] = [];
    const model = gatewayWithFetch(bodies, (body) =>
      asksToCompact(body) ? gatewayItem() : gatewayText("The second claim cites two cases."),
    );

    const first = await run(() =>
      turn(kernelFor(eager(), model, providers), fresh(), "Which sources back the claim?"),
    );
    const reloaded = JSON.parse(JSON.stringify(first)) as HarnessSession;
    await run(() => turn(kernelFor(eager(), model), reloaded, "And the second claim?"));

    expect(new Set(providers)).toEqual(new Set(["gateway"]));
    expect(bodies.filter(asksToCompact).length).toBeGreaterThanOrEqual(1);
    const afterCompaction = bodies.filter((body) => !asksToCompact(body));
    expect(afterCompaction.length).toBeGreaterThanOrEqual(2);
    for (const body of afterCompaction) {
      const sent = JSON.stringify(body.prompt);
      expect(sent).toContain("openai.compaction");
      expect(sent).toContain("ENCRYPTED-STATE");
    }
    for (const body of bodies.filter(
      (candidate) =>
        asksToCompact(candidate) || JSON.stringify(candidate.prompt).includes("ENCRYPTED-STATE"),
    )) {
      expect(body.providerOptions?.gateway?.only).toEqual(["openai"]);
    }
  });

  it("sends a gateway.only the agent set on later requests, and pins only the compaction request to OpenAI", async () => {
    const bodies: GatewayBody[] = [];
    const model = gatewayWithFetch(bodies, (body) =>
      asksToCompact(body) ? gatewayItem() : gatewayText("The second claim cites two cases."),
    );

    const first = await run(() =>
      turn(
        kernelFor(eager(), model, [], { gatewayOptions: { only: ["openai", "azure"] } }),
        fresh(),
        "Which sources back the claim?",
      ),
    );
    await run(() =>
      turn(
        kernelFor(eager(), model, [], { gatewayOptions: { only: ["openai", "azure"] } }),
        JSON.parse(JSON.stringify(first)) as HarnessSession,
        "And the second claim?",
      ),
    );

    expect(bodies.filter(asksToCompact).map((body) => body.providerOptions?.gateway?.only)).toEqual(
      bodies.filter(asksToCompact).map(() => ["openai"]),
    );
    const later = bodies.filter(
      (body) => !asksToCompact(body) && JSON.stringify(body.prompt).includes("ENCRYPTED-STATE"),
    );
    expect(later.length).toBeGreaterThanOrEqual(1);
    for (const body of later) {
      expect(body.providerOptions?.gateway?.only).toEqual(["openai", "azure"]);
    }
  });

  it("never sends history to OpenAI when the agent's gateway.only excludes it, and summarizes with its fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bodies: GatewayBody[] = [];
    const model = gatewayWithFetch(bodies, (body) =>
      asksToCompact(body) ? gatewayItem() : gatewayText("Summary of the conversation so far."),
    );

    const session = await run(() =>
      turn(
        kernelFor(eager(), model, [], { gatewayOptions: { only: ["azure"] } }),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    expect(bodies.filter(asksToCompact)).toEqual([]);
    expect(JSON.stringify(session)).not.toContain("openai.compaction");
    for (const body of bodies) expect(body.providerOptions?.gateway?.only).toEqual(["azure"]);
  });

  it('summarizes as text and says why when an AI Gateway "openai/" model answers without a compaction record', async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: GatewayBody[] = [];
    const model = gatewayWithFetch(bodies, () =>
      gatewayText("Summary of the conversation so far."),
    );

    const session = await run(() =>
      turn(kernelFor(eager(), model), fresh(), "Which sources back the claim?"),
    );

    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("answered the compaction request without a compaction record"),
      expect.anything(),
    );
    expect(
      session.history.some((message) => "kind" in message && message.kind === "context.compaction"),
    ).toBe(true);
    expect(JSON.stringify(session.history)).not.toContain("openai.compaction");
  });
});
