import { describe, expect, it } from "vitest";

import { sessionDeliveryHookWorkflow } from "#internal/testing/session-delivery-hook-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

describe("session delivery hook integration", () => {
  it.each([
    ["old then replacement", ["old", "replacement"] as const],
    ["replacement then old", ["replacement", "old"] as const],
  ])("preserves deliveries committed %s during rekey", async (_label, order) => {
    const suffix = order.join("-");
    const oldToken = `http:session-delivery-hook:${suffix}:old`;
    const replacementToken = `http:session-delivery-hook:${suffix}:replacement`;
    const disposal = await pauseHookDisposal(oldToken);
    const run = await start(sessionDeliveryHookWorkflow, [
      { nextToken: replacementToken, token: oldToken },
    ]);

    try {
      await withTimeout(disposal.started, "old-hook disposal");
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: oldToken }),
        waitForHook({ runId: run.runId }, { token: replacementToken }),
      ]);

      const tokens = { old: oldToken, replacement: replacementToken };
      for (const owner of order) {
        await resumeHook(tokens[owner], {
          kind: "deliver",
          payloads: [{ message: owner }],
        });
      }

      disposal.release();
      await withTimeout(disposal.finished, "old-hook disposal completion");

      await expect(
        resumeHook(oldToken, {
          kind: "deliver",
          payloads: [{ message: "too late" }],
        }),
      ).rejects.toMatchObject({ name: "HookNotFoundError" });
      await expect(run.returnValue).resolves.toEqual(order);
    } finally {
      disposal.release();
      disposal.restore();
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });
});

async function pauseHookDisposal(token: string): Promise<{
  readonly finished: Promise<void>;
  readonly started: Promise<void>;
  release(): void;
  restore(): void;
}> {
  const world = await getWorld();
  const events = world.events as {
    create(...args: unknown[]): Promise<unknown>;
  };
  const originalCreate = events.create.bind(events);
  const started = createDeferred();
  const release = createDeferred();
  const finished = createDeferred();

  events.create = async (...args: unknown[]): Promise<unknown> => {
    const event = args[1] as { readonly correlationId?: string; readonly eventType?: string };
    if (event.eventType === "hook_disposed" && event.correlationId !== undefined) {
      const hook = await world.hooks.get(event.correlationId);
      if (hook.token === token) {
        started.resolve();
        await release.promise;
        try {
          return await originalCreate(...args);
        } finally {
          finished.resolve();
        }
      }
    }
    return await originalCreate(...args);
  };

  return {
    finished: finished.promise,
    release: release.resolve,
    restore() {
      events.create = originalCreate;
    },
    started: started.promise,
  };
}

function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}.`));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
