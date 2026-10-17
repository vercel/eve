import { appendFileSync } from "node:fs";
import { defineEval } from "eve/evals";
import { referenceOf } from "../agent/lib/catalog";
import { measureRun, newRow, type Event } from "./row";

export function measuredEval(id: string, prompt: string, expected: string[]) {
  return defineEval({
    tags: ["real-model"],
    async test(t) {
      const row = newRow(id, process.env);
      const { turn, usedExpectedTools, error } = await measureRun({
        row,
        expected,
        referenceOf,
        // Through a live turn rather than `t.send`, so a turn that times out
        // still hands back the events it streamed.
        start: async () =>
          (await t.session()).start(
            prompt + " Include the exact reference returned by each requested tool in your answer.",
          ),
        collect: (turn, events) => collectChildEvents(turn.session, events, t.signal),
      });
      // The row is written before any assertion, so failed runs are recorded too.
      if (process.env.EVE_ARMS_OUTPUT)
        appendFileSync(process.env.EVE_ARMS_OUTPUT, JSON.stringify(row) + "\n");
      t.log(JSON.stringify(row));
      if (error) throw error;
      turn!.expectOk();
      for (const name of expected) t.messageIncludes(referenceOf(name));
      turn!.eventsSatisfy("requested tools ran in parent or child", () => usedExpectedTools);
    },
  });
}

/**
 * Appends the events of every session the turn opened (subagents, programs),
 * following sessions those open in turn. Events land in `events` as they
 * arrive, so a failure part way keeps everything observed before it.
 */
async function collectChildEvents(session: any, events: Event[], signal: AbortSignal) {
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== "agent.started" || seen.has(event.data.sessionId)) continue;
    seen.add(event.data.sessionId);
    for await (const e of session.agent(event).stream({ follow: false, signal })) events.push(e);
  }
}
