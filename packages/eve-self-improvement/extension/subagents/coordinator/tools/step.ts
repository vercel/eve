import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../../../extension.js";
import { authorizeCoordinator } from "../../../lib/delegation.js";
import {
  acceptAnalysis,
  acceptReview,
  advance,
  codingComplete,
  fail,
  finish,
} from "../../../lib/controller.js";
import {
  taskProgress,
  delegationPending,
  delegationCompleted,
} from "../../../lib/task-progress.js";

export default defineTool({
  description:
    "Advance the private durable experiment. Enforces live app identity, delegation, expiring fenced lease, current stage, tests and release policy. Finish pending work for scheduled resumption; do not declare it shipped.",
  inputSchema: z.discriminatedUnion("action", [
    z.object({ action: z.literal("next") }),
    z.object({ action: z.literal("analysis"), result: z.string().max(16000) }),
    z.object({ action: z.literal("review"), result: z.string().max(16000) }),
    z.object({ action: z.literal("coded"), result: z.string().max(8000) }),
    z.object({ action: z.literal("finish") }),
    z.object({ action: z.literal("abort") }),
  ]),
  async execute(input, ctx) {
    const { lease, experiment: e } = await authorizeCoordinator(extension.config, ctx);
    const progress = taskProgress.get();
    if (delegationPending(progress, ctx.session.turn.id))
      return {
        action: "pending",
        reason:
          "A delegated task is still running. Call eve__task_wait; a start receipt is not its final result.",
      };
    const role =
      input.action === "coded"
        ? "maintainer"
        : ["analysis", "review"].includes(input.action)
          ? "analyst"
          : undefined;
    if (role && !delegationCompleted(progress, ctx.session.turn.id, role))
      throw new Error(
        `No completed ${role} call in this turn; delegate and wait for its actual result`,
      );
    switch (input.action) {
      case "analysis":
        if (e.status !== "analyzing") throw new Error("Analysis is not the current stage");
        return acceptAnalysis(lease, input.result);
      case "review":
        if (!e.reviewDigest || e.reviewDigest === e.reviewedDigest)
          throw new Error("No new observed review is awaiting classification");
        return acceptReview(lease, input.result);
      case "coded":
        await codingComplete(lease, input.result);
        return advance(lease);
      case "finish":
        return finish(lease);
      case "abort":
        return finish(lease, await fail(lease));
      case "next":
        if (e.status === "analyzing") return { action: "analyze", payload: JSON.stringify(e) };
        if (e.status === "coding") return { action: "code", payload: JSON.stringify(e) };
        return advance(lease);
    }
  },
});
