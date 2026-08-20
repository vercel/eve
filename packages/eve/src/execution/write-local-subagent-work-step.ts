import { deserializeContext } from "#context/serialize.js";
import { WorkGraphKey } from "#context/keys.js";

/** Writes the latest committed work graph to a session-owned projection stream. */
export async function writeLocalSubagentWorkStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly workWritable: WritableStream<unknown>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const work = ctx.get(WorkGraphKey);
  if (work === undefined || work.revision === 0) {
    console.error("[eve.work] child projection skipped", { reason: "no-work" });
    return;
  }
  console.error("[eve.work] child projection write", { revision: work.revision });
  const writer = input.workWritable.getWriter();
  try {
    await writer.write(work);
  } finally {
    writer.releaseLock();
  }
}
