import { describe, expect, it } from "vitest";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { sessionCommandInboxWorkflow } from "#internal/testing/session-command-inbox-workflow.js";
import { legacySessionDeliveryWorkflow } from "#internal/testing/legacy-session-delivery-workflow.js";
import { midCohortSessionDeliveryWorkflow } from "#internal/testing/mid-cohort-session-delivery-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("session command inbox integration", () => {
  it("resumes a legacy delivery-only workflow from a current send command", async () => {
    const token = "http:session-command-inbox:legacy-delivery";
    const run = await start(legacySessionDeliveryWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
      });

      await expect(
        runtime.dispatchContinuation({
          command: { kind: "send", payload: { message: "legacy-compatible" } },
          continuationToken: token,
        }),
      ).resolves.toEqual({ sessionId: run.runId, status: "accepted" });
      await expect(run.returnValue).resolves.toBe("legacy-compatible");
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("resumes a 0.30.3–0.30.8 parked consumer from a current send command", async () => {
    const token = "http:session-command-inbox:mid-cohort-delivery";
    const run = await start(midCohortSessionDeliveryWorkflow, [{ token }]);

    try {
      await waitForHook({ runId: run.runId }, { token });
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
      });

      await expect(
        runtime.dispatchContinuation({
          command: { kind: "send", payload: { message: "mid-cohort-compatible" } },
          continuationToken: token,
        }),
      ).resolves.toEqual({ sessionId: run.runId, status: "accepted" });
      await expect(run.returnValue).resolves.toBe("mid-cohort-compatible");
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("accepts commands alternately through the stable ID and channel aliases", async () => {
    const channelToken = "http:session-command-inbox:both-aliases";
    const run = await start(sessionCommandInboxWorkflow, [{ token: channelToken }]);
    const stableToken = sessionCommandHookToken(run.runId);

    try {
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: stableToken }),
        waitForHook({ runId: run.runId }, { token: channelToken }),
      ]);

      await resumeHook(stableToken, { kind: "send", payload: { message: "by id" } });
      await resumeHook(channelToken, {
        kind: "deliver",
        payloads: [{ auth: null, payload: { message: "by channel" } }],
      });

      await expect(run.returnValue).resolves.toEqual(["by id", "by channel"]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it.each([
    ["old then replacement", ["old", "replacement"] as const],
    ["replacement then old", ["replacement", "old"] as const],
  ])("preserves sends committed %s during rekey", async (_label, order) => {
    const suffix = order.join("-");
    const oldToken = `http:session-command-inbox:${suffix}:old`;
    const replacementToken = `http:session-command-inbox:${suffix}:replacement`;
    const disposal = await pauseHookDisposal(oldToken);
    const run = await start(sessionCommandInboxWorkflow, [
      { nextToken: replacementToken, token: oldToken },
    ]);

    try {
      await withTimeout(disposal.started, "old-alias disposal");
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: oldToken }),
        waitForHook({ runId: run.runId }, { token: replacementToken }),
      ]);

      const tokens = { old: oldToken, replacement: replacementToken };
      for (const owner of order) {
        await resumeHook(tokens[owner], { kind: "send", payload: { message: owner } });
      }

      disposal.release();
      await withTimeout(disposal.finished, "old-alias disposal completion");

      await expect(
        resumeHook(oldToken, { kind: "send", payload: { message: "too late" } }),
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
