import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  getHookByToken,
  getWorld,
  start,
  type WorkflowFunction,
} from "#internal/workflow/runtime.js";

/**
 * Starts a session owner run stamped with the running eve version, as
 * `createSession` does. Ingress on single-deployment Worlds treats an owner
 * without the stamp as stranded, so a bare `start` would never accept input.
 */
export async function startSessionOwner<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult>,
  args: TArgs,
) {
  return await start(workflow, args, {
    allowReservedAttributes: true,
    attributes: {
      [EVE_VERSION_ATTRIBUTE]: resolveInstalledPackageInfo().version,
    },
  });
}

interface WorkflowRunLike {
  readonly runId: string;
}

interface WorkflowEventLike {
  readonly correlationId?: string | null;
  readonly eventType?: string;
}

interface WorkflowHookLike {
  readonly hookId: string;
  readonly token: string;
}

/**
 * Waits for a Workflow hook in integration tests.
 */
export async function waitForHook(
  run: WorkflowRunLike,
  options: { pollInterval?: number; timeout?: number; token?: string } = {},
): Promise<WorkflowHookLike> {
  const world = await getWorld();
  const timeout = options.timeout ?? 30_000;
  const pollInterval = options.pollInterval ?? 100;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const [hooks, events] = await Promise.all([
      world.hooks.list({ runId: run.runId }).then((result) => result.data),
      fetchAllEvents(world, run.runId),
    ]);
    const receivedCorrelationIds = new Set(
      events
        .filter((event) => event.eventType === "hook_received")
        .map((event) => event.correlationId),
    );
    const pendingHook = hooks.find(
      (hook) =>
        !receivedCorrelationIds.has(hook.hookId) &&
        (options.token === undefined || hook.token === options.token),
    );

    if (pendingHook !== undefined) {
      return pendingHook;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `waitForHook timed out after ${timeout}ms: no pending hook found for run ${run.runId}${
      options.token === undefined ? "" : ` with token "${options.token}"`
    }`,
  );
}

/** Waits until some run holds the hook `token`, and resolves that run. */
export async function waitForHookOwner(
  token: string,
  timeout = 30_000,
): Promise<{ readonly runId: string }> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return { runId: (await getHookByToken(token)).runId };
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fetchAllEvents(
  world: Awaited<ReturnType<typeof getWorld>>,
  runId: string,
): Promise<WorkflowEventLike[]> {
  const allEvents: WorkflowEventLike[] = [];
  let cursor: string | undefined;

  do {
    const pagination: { cursor?: string; limit: number } = { limit: 1000 };

    if (cursor !== undefined) {
      pagination.cursor = cursor;
    }

    const result = await world.events.list({
      pagination,
      resolveData: "none",
      runId,
    });
    allEvents.push(...result.data);
    cursor = result.hasMore === true && result.cursor !== null ? result.cursor : undefined;
  } while (cursor !== undefined);

  return allEvents;
}
