import { calls, deliveries, reply, usage } from "eve/events";
import { defineHook } from "eve/hooks";

import extension from "../extension.ts";
import { modelJudge, type GoalVerdict } from "../lib/judge.ts";
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
      const costUsd = usage(ctx.view).total.costUsd;
      // A turn is the goal's own when it queued the follow-up and no person's message joined it.
      const followedUp =
        current.followedUp === true &&
        input.length > 0 &&
        input.every(({ source }) => source !== undefined && "hook" in source && !!source.hook);
      const checked = check(current, {
        costUsd,
        followedUp,
        outcome: event.data.outcome,
        toolCalls: turnCalls.length,
      });
      if (checked.kind === "pause") {
        goal.update((g) => g && pause(g, checked.reason));
        return;
      }

      let verdict: GoalVerdict | undefined;
      try {
        const judge = extension.config.judge ?? modelJudge(extension.config.model);
        verdict = await judge({
          abortSignal: ctx.occurrence.abortSignal,
          calls: turnCalls.map(({ input, name, output, state }) => ({
            input,
            name,
            output,
            state,
          })),
          input: input
            .flatMap(({ parts }) => parts ?? [])
            .flatMap((part) => (part.kind === "text" ? [part.text] : []))
            .join("\n"),
          objective: current.objective,
          reply: reply(ctx.view, turnId)
            .flatMap((part) =>
              part.kind === "text" && typeof part.value === "string" ? [part.value] : [],
            )
            .join(""),
        });
      } catch (error) {
        console.warn("The goal judge failed; the goal pauses.", { error });
      }
      const next = settle(
        current,
        verdict,
        { costUsd, idleRuns: checked.idleRuns },
        extension.config,
      );
      // Another hook's follow-up for a different principal refuses this one; the goal goes on
      // from the next turn that settles.
      const queued = next.message !== undefined && ctx.followUp(next.message).queued;
      goal.update(() => (queued ? next.goal : { ...next.goal, followedUp: false }));
    },
  },
});
