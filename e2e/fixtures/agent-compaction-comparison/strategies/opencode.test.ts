import type { StoredHistoryMessage } from "eve/compaction";
import { describe, expect, it } from "vitest";

import {
  compactOf,
  dueOf,
  estimate,
  fakeContext,
  ids,
  pairsIntact,
  toolTurn,
  user,
} from "./fake.js";
import {
  CONTINUE_PROMPT,
  PRUNE_MARKER,
  buildPrompt,
  opencodeCompaction,
  prune,
  serialize,
} from "./opencode.js";

const BIG = "x".repeat(60_000);

function conversation(turnCount: number, output = BIG): StoredHistoryMessage[] {
  return Array.from({ length: turnCount }, (_, index) => [
    user(`question ${index + 1}`),
    ...toolTurn(`call-${index + 1}`, output),
    { role: "assistant" as const, content: `answer ${index + 1}` },
  ]).flat();
}

function marked(history: readonly StoredHistoryMessage[]): string[] {
  return history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          part.output.type === "text" &&
          part.output.value === PRUNE_MARKER
            ? [part.toolCallId]
            : [],
        )
      : [],
  );
}

describe("opencodeCompaction", () => {
  it("summarizes a transcript of the head with no system, then keeps the tail and continues", async () => {
    const { ctx, calls } = fakeContext({ limit: 100_000 });
    const history = conversation(3, "short");
    const preserveRecentTokens = estimate(history.slice(8));
    const result = await compactOf(opencodeCompaction({ preserveRecentTokens }))(history, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([]);
    expect(calls[0]!.options!.system).toBe("");
    expect(calls[0]!.options!.prompt).toContain("[User]: question 1");
    expect(calls[0]!.options!.prompt).toContain("[Tool result]: short");
    expect(result!.slice(0, 2)).toEqual(ctx.checkpoint("SUMMARY"));
    expect(result!.slice(2, -1)).toEqual(history.slice(8));
    expect(result!.at(-1)).toEqual({
      role: "user",
      kind: "execution.continuation",
      content: CONTINUE_PROMPT,
    });
  });

  it("keeps the end of a turn too big for the tail, its calls with their results", async () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const history = [
      user("question"),
      ...toolTurn("call-1", "a".repeat(4_000)),
      ...toolTurn("call-2", "b".repeat(400)),
    ];
    const result = await compactOf(opencodeCompaction({ preserveRecentTokens: 300 }))(history, ctx);
    expect(ids(result!)).toEqual(["call-2"]);
    expect(pairsIntact(result!)).toBe(true);
  });

  it("updates the previous summary instead of summarizing it again", async () => {
    const { ctx, calls } = fakeContext({ limit: 100_000 });
    const history = [...ctx.checkpoint("OLD"), ...conversation(2, "short")];
    await compactOf(opencodeCompaction({ preserveRecentTokens: 60 }))(history, ctx);
    const prompt = calls[0]!.options!.prompt!;
    expect(prompt).toContain("<prior-summary>\nOLD\n</prior-summary>");
    expect(prompt).not.toContain("[Assistant]: OLD");
  });

  it("replays the turn's input after the summary on overflow", async () => {
    const { ctx } = fakeContext({ limit: 100_000, reason: "overflow" });
    const history = [...conversation(2, "short"), user("question 3"), ...toolTurn("call-3", BIG)];
    const result = await compactOf(opencodeCompaction({ preserveRecentTokens: 1 }))(history, ctx);
    expect(result!.at(-1)).toEqual(user("question 3"));
    expect(ids(result!)).not.toContain("call-3");
  });

  it("is due at the window less the model's output limit, at most 32k", () => {
    const due = dueOf(opencodeCompaction());
    const base = { phase: "step" as const, threshold: 150_000, contextWindowTokens: 200_000 };
    expect(due({ ...base, maxOutputTokens: 64_000, inputTokens: 167_999 })).toBe(false);
    expect(due({ ...base, maxOutputTokens: 64_000, inputTokens: 168_000 })).toBe(true);
    expect(due({ ...base, maxOutputTokens: 8_000, inputTokens: 192_000 })).toBe(true);
    expect(dueOf(opencodeCompaction({ reserved: 20_000 }))({ ...base, inputTokens: 180_000 })).toBe(
      true,
    );
  });

  it("prunes at turn end only when asked to", () => {
    expect(opencodeCompaction()).toMatchObject({ when: { phases: ["step"] } });
    expect(opencodeCompaction({ prune: true })).toMatchObject({
      when: { phases: ["step", "turn-end"] },
    });
  });
});

describe("prune", () => {
  it("clears outputs past the protected 40k outside the last two turns", () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const result = prune(conversation(6), ctx)!;
    expect(marked(result)).toEqual(["call-1", "call-2"]);
    expect(pairsIntact(result)).toBe(true);
  });

  it("leaves the history when clearing frees 20k or less", () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    expect(prune(conversation(5), ctx)).toBeUndefined();
  });

  it("stops at an output already cleared", () => {
    const { ctx } = fakeContext({ limit: 100_000 });
    const once = prune(conversation(6), ctx)!;
    const again = prune([...once, ...conversation(1)], ctx, { pruneMinimum: 0 });
    expect(marked(again ?? once)).toContain("call-1");
  });
});

describe("serialize", () => {
  it("cuts tool output to 2,000 characters and skips framework messages", () => {
    const [call, result] = toolTurn("call-1", "z".repeat(3_000));
    expect(serialize(result!)).toBe(`[Tool result]: ${"z".repeat(2_000)}\n[truncated]`);
    expect(serialize(call!)).toBe('[Assistant tool call]: bash({"cmd":"call-1"})');
    expect(serialize({ role: "user", kind: "context.state", content: "state" })).toBe("");
  });

  it("keeps a placeholder for each file a user message or tool result attaches", () => {
    expect(
      serialize({
        content: [
          { text: "Inspect attached report", type: "text" },
          {
            data: "JVBERi0=",
            filename: "incident.pdf",
            mediaType: "application/pdf",
            type: "file",
          },
        ],
        kind: "user",
        role: "user",
      }),
    ).toBe("[User]: Inspect attached report\n[Attached application/pdf: incident.pdf]");
    expect(
      serialize({
        content: [
          {
            output: {
              type: "content",
              value: [
                { text: "Rendered the chart.", type: "text" },
                { data: "iVBORw0=", mediaType: "image/png", type: "image-data" },
              ],
            },
            toolCallId: "call-1",
            toolName: "chart",
            type: "tool-result",
          },
        ],
        role: "tool",
      }),
    ).toBe("[Tool result]: Rendered the chart.\n[Attached image/png: file]");
  });

  it("builds opencode's prompt, with the prior summary when there is one", () => {
    expect(buildPrompt({ context: ["A"] })).toContain("Create a new anchored summary");
    expect(buildPrompt({ context: ["A"], previousSummary: "S" })).toContain(
      "<prior-summary>\nS\n</prior-summary>",
    );
  });
});
