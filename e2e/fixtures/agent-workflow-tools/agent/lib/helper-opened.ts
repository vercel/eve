/**
 * A handshake that opens a background task's helper session while the parent's
 * model step is generating: the parent's model marks that it is generating and
 * waits for the helper, and the task waits for that mark before it opens the
 * helper. Marks are keyed by the task's call id, which both sides see and no
 * other run shares. The task's steps and the parent's model call share this
 * process in a local dev server; where they do not, each side only waits out
 * its bound.
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

/** The parent's model step after task call `callId` is generating; waits until its helper opened. */
export async function generateWhileHelperOpens(callId: string): Promise<void> {
  marks().add(`generating:${callId}`);
  await consumeMark(`opened:${callId}`);
}

/** Holds task call `callId` until the parent's next model step is generating. */
export async function waitForParentGenerating(callId: string): Promise<void> {
  "use step";
  await consumeMark(`generating:${callId}`);
}

/** Records that the helper of task call `callId` opened; its session already announced it. */
export async function markHelperOpened(callId: string): Promise<void> {
  "use step";
  marks().add(`opened:${callId}`);
}
