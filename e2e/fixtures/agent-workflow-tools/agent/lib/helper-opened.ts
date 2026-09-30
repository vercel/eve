/**
 * A handshake that opens a background task's helper session while the parent's
 * model step is generating: the parent's model marks that it is generating and
 * waits for the helper, and the task waits for that mark before it opens the
 * helper. The task's steps and the parent's model call share this process in a
 * local dev server; where they do not, each side only waits out its bound.
 */
const WAIT_MS = 5_000;

function marks(): Set<string> {
  const shared = globalThis as typeof globalThis & { eveE2eHelperMarks?: Set<string> };
  return (shared.eveE2eHelperMarks ??= new Set());
}

/** Resolves once `mark` is set, or after the bound, and consumes it. */
async function consumeMark(mark: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!marks().has(mark) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  marks().delete(mark);
}

/** The parent's model step for `topic` is generating; waits until the helper opened. */
export async function generateWhileHelperOpens(topic: string): Promise<void> {
  marks().add(`generating:${topic}`);
  await consumeMark(`opened:${topic}`);
}

/** Holds the task until the parent's model step for `topic` is generating. */
export async function waitForParentGenerating(topic: string): Promise<void> {
  "use step";
  await consumeMark(`generating:${topic}`);
}

/** Records that the helper for `topic` opened; its session has already announced it. */
export async function markHelperOpened(topic: string): Promise<void> {
  "use step";
  marks().add(`opened:${topic}`);
}
