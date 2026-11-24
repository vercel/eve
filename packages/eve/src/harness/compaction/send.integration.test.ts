import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";
import {
  INJECTED,
  type ResponsesBody,
  fresh,
  kernelFor,
  openaiWithFetch,
  turn,
} from "#internal/testing/openai-responses.js";
import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

type CompactionRewrite = (
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) => Promise<readonly StoredHistoryMessage[] | undefined>;

const endsInItem = (history: readonly StoredHistoryMessage[]) =>
  history.at(-1)?.role === "assistant" &&
  Array.isArray(history.at(-1)!.content) &&
  (history.at(-1)!.content as { kind?: string }[]).some(
    (part) => part.kind === "openai.compaction",
  );

const OPENAI_NATIVE: CompactionRewrite = async (history, ctx) =>
  endsInItem(history)
    ? undefined
    : await ctx.send(history, {
        providerOptions: { openai: { compactionTrigger: true, store: false } },
      });

describe("a strategy that sends the turn's own request", () => {
  it("sends the turn's instructions and tools without eve's injected messages, as the provider's own provider options ask", async () => {
    const bodies: ResponsesBody[] = [];
    const providers: string[] = [];

    await contextStorage.run(new ContextContainer(), () =>
      turn(
        kernelFor(OPENAI_NATIVE, openaiWithFetch(bodies), providers),
        fresh(),
        "Which sources back the claim?",
      ),
    );

    const [compacting] = bodies;
    expect(new Set(providers)).toEqual(new Set(["openai.responses"]));
    expect(compacting!.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(compacting!.store).toBe(false);
    expect(JSON.stringify(compacting!.input[0])).toContain("You help Alice.");
    expect(compacting!.tools?.map((tool) => tool.name)).toContain("lookup");
    const sent = JSON.stringify(compacting!.input);
    for (const injected of INJECTED) expect(sent).not.toContain(String(injected.content));
    expect(sent).toContain("Review Alice's contract.");
    expect(sent).toContain("I reviewed it.");
  });

  it("keeps the provider's item on the stored message, so a reloaded session still sends it", async () => {
    const bodies: ResponsesBody[] = [];
    const kernel = kernelFor(OPENAI_NATIVE, openaiWithFetch(bodies));

    const session = await contextStorage.run(new ContextContainer(), () =>
      turn(kernel, fresh(), "Which sources back the claim?"),
    );

    expect(session.history).toContainEqual({
      content: [
        {
          kind: "openai.compaction",
          providerOptions: {
            openai: { encryptedContent: "ENCRYPTED-STATE", itemId: "cmp_1", type: "compaction" },
          },
          type: "custom",
        },
      ],
      role: "assistant",
    });

    const reloaded = JSON.parse(JSON.stringify(session)) as HarnessSession;
    await contextStorage.run(new ContextContainer(), () =>
      turn(kernelFor(OPENAI_NATIVE, openaiWithFetch(bodies)), reloaded, "And the second claim?"),
    );

    const after = bodies.at(-1)!.input;
    expect(after).toContainEqual({
      encrypted_content: "ENCRYPTED-STATE",
      id: "cmp_1",
      type: "compaction",
    });
    expect(JSON.stringify(after)).not.toContain("item_reference");
  });

  it("sends the same instructions and tools as the turn when it compacts at turn.settled", async () => {
    const bodies: ResponsesBody[] = [];
    const kernel = kernelFor(OPENAI_NATIVE, openaiWithFetch(bodies), [], {
      when: { "turn.settled": true },
    });

    await contextStorage.run(new ContextContainer(), () =>
      turn(kernel, fresh(), "Which sources back the claim?"),
    );

    const [asked, compacting] = bodies;
    expect(compacting!.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(asked!.tools?.map((tool) => tool.name)).toContain("lookup");
    expect(compacting!.tools).toEqual(asked!.tools);
    expect(compacting!.input[0]).toEqual(asked!.input[0]);
  });

  it("sends the same instructions and tools as the turn when the compaction is manual", async () => {
    const bodies: ResponsesBody[] = [];
    const model = openaiWithFetch(bodies);

    await contextStorage.run(new ContextContainer(), () =>
      kernelFor(OPENAI_NATIVE, model, [], { compactOnly: true })(fresh(), {}),
    );
    await contextStorage.run(new ContextContainer(), () =>
      turn(kernelFor(OPENAI_NATIVE, model), fresh(), "Which sources back the claim?"),
    );

    const manual = bodies.find((body) => body.input.at(-1)?.type === "compaction_trigger");
    const ofTurn = bodies.find((body) => body.input.at(-1)?.type !== "compaction_trigger");
    expect(manual).toBeDefined();
    expect(manual!.tools).toEqual(ofTurn!.tools);
    expect(manual!.input[0]).toEqual(ofTurn!.input[0]);
  });
});
