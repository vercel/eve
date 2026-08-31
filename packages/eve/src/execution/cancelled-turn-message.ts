import { stageAttachmentsToSandbox } from "#harness/attachment-staging.js";
import { normalizeUserContent } from "#harness/messages.js";
import type { HarnessSession, StepInput } from "#harness/types.js";

export async function preserveCancelledTurnMessage(
  session: HarnessSession,
  input: StepInput | undefined,
): Promise<HarnessSession> {
  const message = normalizeUserContent(input?.message);
  if (message === undefined) return session;
  const content = await stageAttachmentsToSandbox(message);
  return { ...session, history: [...session.history, { content, role: "user" }] };
}
