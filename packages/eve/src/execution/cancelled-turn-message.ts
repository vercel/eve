import { stageAttachmentsToSandbox } from "#harness/attachment-staging.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  frameworkMessageKindForStepInput,
  normalizeMessage,
  userContentOf,
} from "#harness/messages.js";
import type { HarnessSession, HarnessStepInput } from "#harness/types.js";

export async function preserveCancelledTurnMessage(
  session: HarnessSession,
  input: HarnessStepInput | undefined,
): Promise<HarnessSession> {
  const message = normalizeMessage(input?.message);
  if (message === undefined) return session;
  const content = await stageAttachmentsToSandbox(userContentOf(message));
  const frameworkMessageKind = frameworkMessageKindForStepInput(input);
  return {
    ...session,
    history: [
      ...session.history,
      frameworkMessageKind === undefined
        ? createUserMessage("user", content)
        : createFrameworkUserMessage(frameworkMessageKind, content),
    ],
  };
}
