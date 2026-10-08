import { appendFileSync } from "node:fs";
import { defineEval } from "eve/evals";
import { referenceOf } from "../agent/lib/catalog";
export function measuredEval(id: string, prompt: string, expected: string[]) {
  return defineEval({
    tags: ["real-model"],
    async test(t) {
      const start = performance.now();
      const turn = await t.send(
        prompt + " Include the exact reference returned by each requested tool in your answer.",
      );
      const latencyMs = performance.now() - start;
      turn.expectOk();
      for (const name of expected) t.messageIncludes(referenceOf(name));
      const streams = [turn.events];
      const seen = new Set<string>();
      for (const event of turn.events) {
        if (event.type !== "agent.started" || seen.has(event.data.sessionId)) continue;
        seen.add(event.data.sessionId);
        const child = [];
        for await (const e of turn.session.agent(event).stream({ follow: false, signal: t.signal }))
          child.push(e);
        streams.push(child);
      }
      const requested = streams
        .flat()
        .flatMap((e) => (e.type === "actions.requested" ? e.data.actions : []));
      const usedExpectedTools = expected.every((name) =>
        requested.some((a) => "toolName" in a && a.toolName === name),
      );
      turn.eventsSatisfy("requested tools ran in parent or child", () => usedExpectedTools);
      const steps = streams.flat().filter((e) => e.type === "step.completed");
      const usage = steps.reduce(
        (sum, e) => ({
          inputTokens: sum.inputTokens + (e.data.usage?.inputTokens ?? 0),
          cacheReadTokens: sum.cacheReadTokens + (e.data.usage?.cacheReadTokens ?? 0),
          cacheWriteTokens: sum.cacheWriteTokens + (e.data.usage?.cacheWriteTokens ?? 0),
        }),
        { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      );
      const row = {
        id,
        arm: process.env.EVE_ARMS_MODE,
        size: process.env.EVE_ARMS_SIZE,
        model: process.env.EVE_E2E_MODEL,
        repetition: Number(process.env.EVE_ARMS_REPETITION ?? 1),
        success:
          usedExpectedTools &&
          turn.status !== "failed" &&
          expected.every((name) => turn.message?.includes(referenceOf(name))),
        latencyMs,
        modelCalls: steps.length,
        missingUsage: steps.filter((e) => !e.data.usage).length,
        ...usage,
        tools: requested,
        message: turn.message,
      };
      if (process.env.EVE_ARMS_OUTPUT)
        appendFileSync(process.env.EVE_ARMS_OUTPUT, JSON.stringify(row) + "\n");
      t.log(JSON.stringify(row));
    },
  });
}
