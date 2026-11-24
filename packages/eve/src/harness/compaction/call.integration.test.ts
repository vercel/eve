import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  INJECTED,
  type ResponsesBody,
  fresh,
  kernelFor,
  openaiWithFetch,
  turn,
} from "#internal/testing/openai-responses.js";
import { withoutInjected } from "#public/experimental/compaction/injected.js";
import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

const SUMMARIZE = async (history: readonly StoredHistoryMessage[], ctx: CompactionContext) => {
  if (!ctx.requested && !ctx.overflow && ctx.tokens <= 80) return undefined;
  const sendable = withoutInjected(history);
  const { text } = await ctx.call({
    messages: sendable,
    providerOptions: { openai: { store: false } },
    tools: "inherit",
  });
  return [
    { content: "Summary:", kind: "context.compaction", role: "user" },
    { content: text, role: "assistant" },
    ...history.slice(-1),
  ] satisfies StoredHistoryMessage[];
};

describe("a strategy that calls the model with ctx.call()", () => {
  it("sends the turn's instructions and tools without eve's injected messages, as the provider's own provider options ask", async () => {
    const bodies: ResponsesBody[] = [];
    const providers: string[] = [];

    await contextStorage.run(new ContextContainer(), () =>
      turn(
        kernelFor(SUMMARIZE, openaiWithFetch(bodies), providers),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    const [compacting] = bodies;
    expect(new Set(providers)).toEqual(new Set(["openai.responses"]));
    expect(compacting!.store).toBe(false);
    expect(JSON.stringify(compacting!.input[0])).toContain("You help Alice.");
    expect(compacting!.tools?.map((tool) => tool.name)).toContain("lookup");
    const sent = JSON.stringify(compacting!.input);
    for (const injected of INJECTED) expect(sent).not.toContain(String(injected.content));
    expect(sent).toContain("Review Alice's contract.");
    expect(sent).toContain("I reviewed it.");
  });

  it("sends the same instructions and tools as the turn when the compaction is manual", async () => {
    const bodies: ResponsesBody[] = [];
    const model = openaiWithFetch(bodies);

    await contextStorage.run(new ContextContainer(), () =>
      kernelFor(SUMMARIZE, model, [], { compactOnly: true })(fresh(), {}),
    );
    await contextStorage.run(new ContextContainer(), () =>
      turn(kernelFor(SUMMARIZE, model), fresh(), "Which sources back the claim?"),
    );

    const [manual, ofTurn] = bodies;
    expect(manual!.tools).toEqual(ofTurn!.tools);
    expect(manual!.input[0]).toEqual(ofTurn!.input[0]);
  });
});
