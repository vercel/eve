import { randomBytes } from "node:crypto";

import type { ValidQueueName } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  localRecoveryMessage,
  releaseOrphanedLocalSteps,
} from "#internal/workflow/local-world-recovery.js";
import {
  workflowQueuePrefix,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";

export const LOCAL_WORKFLOW_DELIVERY_HEADER = "x-eve-workflow-delivery";

export function authenticateLocalWorkflowDeliveries(
  world: LocalWorld,
  secret: string = randomBytes(32).toString("hex"),
): LocalWorld {
  const enqueue = world.queue.bind(world);
  world.queue = async (queueName, message, options) =>
    await enqueue(queueName, message, {
      ...options,
      headers: { ...options?.headers, [LOCAL_WORKFLOW_DELIVERY_HEADER]: secret },
    });

  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (queueNamePrefix, handler) => {
    const deliver = createQueueHandler(queueNamePrefix, handler);
    return async (request) => {
      const proof = request.headers.get(LOCAL_WORKFLOW_DELIVERY_HEADER);
      if (proof === null || !timingSafeEqualStrings(proof, secret)) {
        return Response.json({ error: "Untrusted workflow delivery." }, { status: 401 });
      }
      return await deliver(request);
    };
  };

  const start = world.start?.bind(world);
  world.start = async () => {
    await start?.();
    await reenqueueActiveRuns(world);
  };
  return world;
}

async function reenqueueActiveRuns(world: LocalWorld): Promise<void> {
  const namespace = process.env[WORKFLOW_QUEUE_NAMESPACE_ENV];
  if (!namespace) {
    throw new Error(
      `${WORKFLOW_QUEUE_NAMESPACE_ENV} must be installed before local workflow recovery.`,
    );
  }
  const prefix = workflowQueuePrefix(namespace);
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { cursor },
      resolveData: "none",
      status: ["pending", "running"],
    });
    await releaseOrphanedLocalSteps(
      world,
      page.data.map((run) => run.runId),
    );
    for (const run of page.data) {
      try {
        await world.queue(
          `${prefix}${run.workflowName}` as ValidQueueName,
          localRecoveryMessage(run),
        );
      } catch (error) {
        console.warn(`[eve] Failed to re-enqueue workflow run ${run.runId}:`, error);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
}
