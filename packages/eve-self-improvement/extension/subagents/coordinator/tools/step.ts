import { defineTool } from "eve/tools";
import { taskProgress, delegationPending } from "../../../lib/task-progress.js";
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

export default defineTool({
  description:
    "Advance the private durable experiment. Enforces live app identity, delegation, expiring fenced lease, current stage, tests and release policy. Finish pending work for scheduled resumption; do not declare it shipped.",
  inputSchema: z.object({
    action: z.enum(["next", "analysis", "review", "coded", "finish", "abort"]),
  }),
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
    const completed =
      role && progress.turnId === ctx.session.turn.id
        ? progress.calls.findLast((call) => call.name === role)
        : undefined;
    const result = completed?.output ?? "";
    if (role && (completed?.state !== "completed" || !result))
      throw new Error(
        `No completed ${role} call in this turn; delegate and wait for its actual result`,
      );
    switch (input.action) {
      case "analysis":
        if (e.status !== "analyzing") throw new Error("Analysis is not the current stage");
        return acceptAnalysis(lease, result);
      case "review":
        if (!e.reviewDigest || e.reviewDigest === e.reviewedDigest)
          throw new Error("No new observed review is awaiting classification");
        return acceptReview(lease, result);
      case "coded":
        await codingComplete(lease, result);
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
