import { defineTool } from "eve/tools";
import { createHook } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";

import { type ReplicaResult, planReplica } from "../lib/fanout.ts";

/**
 * Starts a fan-out of child workflow runs from inside a body and collects
 * their results on reply hooks. Exercises `start` and `resumeHook` across the
 * run boundary.
 */
export default defineTool({
  description: "Plan several deploy replicas in parallel and combine their digests.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }) {
    "use workflow";

    const replies = [0, 1].map(() => createHook<ReplicaResult>());
    await Promise.all(
      replies.map((reply, replica) =>
        start(planReplica, [{ replica, replyTo: reply.token, service }]),
      ),
    );
    const replicas = await Promise.all(replies.map((reply) => reply));
    return { replicas };
  },
});
