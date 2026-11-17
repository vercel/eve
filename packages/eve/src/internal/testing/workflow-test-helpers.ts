import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  getHookByToken,
  getWorld,
  start,
  type WorkflowFunction,
} from "#internal/workflow/runtime.js";

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

export async function waitForHook(
  run: WorkflowRunLike,
  options: { pollInterval?: number; timeout?: number; token?: string } = {},
): Promise<WorkflowHookLike> {
  const world = await getWorld();
  const timeout = options.timeout ?? 30_000;
  const pollInterval = options.pollInterval ?? 25;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const hooks = await world.hooks.list({ runId: run.runId }).then((result) => result.data);
    const candidates = hooks.filter(
      (hook) => options.token === undefined || hook.token === options.token,
    );

    if (candidates.length > 0) {
      const receivedCorrelationIds = await receivedHookIds(world, run.runId, candidates);
      const pendingHook = candidates.find((hook) => !receivedCorrelationIds.has(hook.hookId));

      if (pendingHook !== undefined) {
        return pendingHook;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `waitForHook timed out after ${timeout}ms: no pending hook found for run ${run.runId}${
      options.token === undefined ? "" : ` with token "${options.token}"`
    }`,
  );
}

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

async function receivedHookIds(
  world: Awaited<ReturnType<typeof getWorld>>,
  runId: string,
  hooks: readonly WorkflowHookLike[],
): Promise<Set<string>> {
  const received = await Promise.all(
    hooks.map(async (hook) => {
      const events = await world.events.listByCorrelationId({
        correlationId: hook.hookId,
        resolveData: "none",
        runId,
      });
      return events.data.some((event: WorkflowEventLike) => event.eventType === "hook_received")
        ? hook.hookId
        : undefined;
    }),
  );

  return new Set(received.filter((hookId) => hookId !== undefined));
}
