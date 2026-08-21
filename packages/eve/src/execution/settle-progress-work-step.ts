import { ProgressKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { ProgressWorkPhase } from "#protocol/progress.js";
import { reportProgress } from "#execution/submit-progress.js";

/** Best-effort settlement for one delegated work item. */
export async function settleProgressWorkStep(input: {
  readonly outcome: Exclude<ProgressWorkPhase, "running">;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const progress = ctx.get(ProgressKey);
  if (progress?.workIdentity === undefined) return;
  await reportProgress({
    callback: progress.callback,
    events: [
      {
        eventId: `${progress.workIdentity.id}:settled:${input.outcome}`,
        kind: "work.settled",
        outcome: input.outcome,
        settledAt: new Date().toISOString(),
        workId: progress.workIdentity.id,
      },
    ],
  });
}
