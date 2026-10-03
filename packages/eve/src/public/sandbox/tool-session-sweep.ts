import { contextStorage } from "#context/container.js";
import { getActiveRuntimeNode } from "#context/node.js";
import { sweepToolSessionSandboxes as sweep } from "#execution/tool-session/sandbox.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("tool-session.sweep");

/**
 * Deletes the agent's tool-session sandboxes that no `invokeTool` call has
 * used for 30 days. A tool session has no end that would delete its sandbox,
 * so an app that uses keyed calls runs this from a schedule to bound how
 * long an abandoned session's sandbox is kept:
 *
 * ```ts
 * // agent/schedules/tool-session-sweep.ts
 * export default defineSchedule({ cron: "17 4 * * 0", run: sweepToolSessionSandboxes });
 * ```
 *
 * A sandbox that is running, or that a call on this instance is using, is
 * kept. Only Vercel Sandbox can list its tool-session sandboxes; on another
 * provider the sweep logs that it skipped and deletes nothing.
 */
export async function sweepToolSessionSandboxes(): Promise<void> {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    throw new Error(
      "sweepToolSessionSandboxes runs only from a schedule handler, where it can reach the agent's sandbox.",
    );
  }
  const result = await sweep({ registry: getActiveRuntimeNode(ctx).sandboxRegistry });
  log.info("swept tool-session sandboxes", {
    deleted: result.deleted.length,
    failed: result.failed.length,
    skipped: result.skipped ?? null,
  });
}
