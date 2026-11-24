import { createAnthropic } from "@ai-sdk/anthropic";
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
import { openaiCompaction } from "#public/compaction/index.js";

const run = <T>(fn: () => Promise<T>) => contextStorage.run(new ContextContainer(), fn);

const isTrigger = isCompactionTrigger;

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

afterEach(() => vi.restoreAllMocks());

describe("openaiCompaction()", () => {
  it("compacts the turn's own request into OpenAI's item, without eve's injected messages", async () => {
    const bodies: ResponsesBody[] = [];

    const session = await run(() =>
      turn(
        kernelFor(openaiCompaction(), openaiWithFetch(bodies)),
        fresh(),
        "Which sources back the claim?",
      ),
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
      turn(kernelFor(openaiCompaction(), model), fresh(), "Which sources back the claim?"),
    );
    const reloaded = JSON.parse(JSON.stringify(first)) as HarnessSession;
    await run(() => turn(kernelFor(openaiCompaction(), model), reloaded, "And the second claim?"));

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
      turn(
        kernelFor(openaiCompaction(), model, [], options),
        fresh(),
        "Which sources back the claim?",
      ),
    );
    const reloaded = JSON.parse(JSON.stringify(first)) as HarnessSession;
    await run(() =>
      turn(kernelFor(openaiCompaction(), model, [], options), reloaded, "And the second claim?"),
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
      turn(
        kernelFor(openaiCompaction(), model, [], {
          when: { "model.requested": () => true },
        }),
        fresh(),
        "Which sources back the claim?",
      ),
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
    let first = true;
    const model = openaiWithFetch(bodies, (body) => {
      if (isTrigger(body)) return compactionReply(`cmp_${++triggers}`, `STATE-${triggers}`);
      calls += 1;
      if (calls === 1) return functionCallReply("call_1");
      return calls === 2 ? contextOverflowReply() : textReply("Done.");
    });

    const session = await run(() =>
      turn(
        kernelFor(openaiCompaction(), model, [], {
          when: {
            "model.requested": () => {
              const due = first;
              first = false;
              return due;
            },
          },
        }),
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
        model: { provider: "openai.responses", modelId: "gpt-5" },
        send,
        session: { id: "s" },
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
      turn(kernelFor(openaiCompaction(), model), fresh(), "Which sources back the claim?"),
    );

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI compaction failed; eve summarizes as text instead"),
      expect.anything(),
    );
    expect(
      session.history.some((message) => "kind" in message && message.kind === "context.compaction"),
    ).toBe(true);
    expect(JSON.stringify(session.history)).not.toContain("openai.compaction");
  });

  it("summarizes as text and says why on a provider other than OpenAI's Responses API", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: Record<string, unknown>[] = [];

    const session = await run(() =>
      turn(
        kernelFor(openaiCompaction(), anthropicWithFetch(bodies)),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("openaiCompaction() needs the OpenAI Responses API"),
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
        kernelFor(openaiCompaction(), openaiWithFetch(openaiBodies)),
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
});
