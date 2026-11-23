import { defineTool } from "eve/tools";
import { isScheduleAuth } from "eve/schedules";
import { z } from "zod";
import extension from "../extension.js";
import { feedbackScope, observe } from "../lib/observe.js";

/** Records explicit feedback within the actual conversation and authenticated principal scope. */
export default defineTool({
  description:
    "Record explicit user feedback about the current or previous answer, without saving message text. Use only when the user actually corrected or assessed that answer.",
  inputSchema: z.object({
    kind: z.enum(["correction", "success", "failure"]),
    target: z.string().min(1).max(100).default("agent"),
    answer: z.enum(["previous", "current"]).default("previous"),
    confidence: z.number().min(0).max(1),
  }),
  async execute(input, ctx) {
    if (!ctx.session.auth.current || isScheduleAuth(ctx.session.auth.current) || ctx.session.parent)
      throw new Error("Feedback requires an authenticated user session");
    const scope = feedbackScope.get();
    const turnId = input.answer === "previous" ? scope.previous : ctx.session.turn.id;
    if (!turnId) return { recorded: false, reason: "No previous answer in this session" };
    const targets = input.answer === "previous" ? scope.previousTargets : scope.currentTargets;
    if (input.target !== "agent" && !targets.includes(input.target))
      throw new Error("Feedback target must have executed in the selected answer");
    await observe(extension.config, {
      id: `feedback:${ctx.session.id}:${ctx.callId}`,
      at: Date.now(),
      session: ctx.session.id,
      turn: turnId,
      principal: `${ctx.session.auth.current.authenticator}:${ctx.session.auth.current.principalId}`,
      kind: "feedback",
      target: input.target,
      feedback: input.kind,
      confidence: input.confidence,
      revision: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    return { recorded: true };
  },
});
