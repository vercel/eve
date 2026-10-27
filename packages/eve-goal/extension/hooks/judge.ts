import { calls, deliveries, usage } from "eve/events";
import { defineHook } from "eve/hooks";

import extension from "../extension.ts";
import { modelJudge } from "../lib/judge.ts";
import { check, pause, settle } from "../lib/policy.ts";
import { goal } from "../lib/state.ts";

export default defineHook({
  events: {
    // The first call that settles after the goal is set marks where its spend starts.
    "call.settled"(_event, ctx) {
      const current = goal.get();
      if (current?.status !== "active" || current.costAtStart !== undefined) return;
      const costAtStart = usage(ctx.view).total.costUsd ?? 0;
      goal.update((g) => g && { ...g, costAtStart });
    },
    async "turn.settled"(event, ctx) {
      const current = goal.get();
      if (current?.status !== "active") return;
      const { turnId } = event.data;
      const turnCalls = calls(ctx.view, { turnId });
      const input = deliveries(ctx.view, { turnId });
      const checked = check(
        current,
        {
          continued:
            input.length > 0 &&
            input.every(
              ({ source }) => source !== undefined && "hook" in source && source.hook !== undefined,
            ),
          costUsd: usage(ctx.view).total.costUsd,
          outcome: event.data.outcome,
          toolCalls: turnCalls.length,
        },
        extension.config,
      );
      if (checked.kind === "pause") {
        goal.update((g) => g && pause(g, checked.reason));
        return;
      }

      const judge = extension.config.judge ?? modelJudge(extension.config.model);
      const verdict = await judge({
        abortSignal: ctx.occurrence.abortSignal,
        calls: turnCalls.map(({ input, name, output, state }) => ({ input, name, output, state })),
        input: input
          .flatMap(({ parts }) => parts ?? [])
          .flatMap((part) => (part.kind === "text" ? [part.text] : []))
          .join("\n"),
        objective: current.objective,
        reply: (event.data.reply ?? []).join("\n"),
      }).catch((error: unknown) => {
        console.warn("The goal judge failed; the goal pauses.", { error });
        return undefined;
      });
      const next = settle(current, verdict, checked.idleRuns);
      goal.update(() => next.goal);
      // `queued: false` only when another hook already followed up this turn; it goes on either way.
      if (next.message !== undefined) ctx.followUp(next.message);
    },
  },
});
