import { mkdir, writeFile } from "node:fs/promises";

import { defineEval } from "eve/evals";

import { codeOf, FILES, TURNS } from "../constants";

const strategy = process.env.EVE_COMPACTION_STRATEGY ?? "default";

export default defineEval({
  description: `The replay task survives compaction with the ${strategy} strategy.`,
  async test(t) {
    const session = await t.session();
    const compactions: { phase: string; outcome: string }[] = [];
    let modelCalls = 0;
    let reads = 0;
    const usage = { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };
    let turn: Awaited<ReturnType<typeof session.send>> | undefined;
    for (const message of TURNS) {
      turn = await session.send(message);
      turn.expectOk();
      reads += turn.toolCalls.length;
      turn.events.forEach((event, index) => {
        if (event.type === "model.started") modelCalls++;
        if (event.type === "usage.recorded") {
          usage.cacheReadTokens += event.data.usage.cacheReadTokens;
          usage.inputTokens += event.data.usage.inputTokens;
          usage.outputTokens += event.data.usage.outputTokens;
        }
        if (event.type !== "context.settled" || event.data.kind !== "compaction") return;
        // A step compaction runs before a model call; a turn-end one has none after it.
        const callFollows = turn!.events
          .slice(index + 1)
          .some((later) => later.type === "model.started");
        compactions.push({ outcome: event.data.outcome, phase: callFollows ? "step" : "turn-end" });
      });
    }
    const code = codeOf(FILES[0]!);
    const answered = turn?.reply?.includes(code) ?? false;
    await mkdir(".replay", { recursive: true });
    await writeFile(
      `.replay/${strategy}.json`,
      `${JSON.stringify({ answered, compactions, modelCalls, reads, strategy, usage }, null, 2)}\n`,
    );

    t.event("context.settled", { data: { kind: "compaction", outcome: "completed" } });
    turn?.messageIncludes(code);
  },
});
