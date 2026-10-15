import { initializeOwnerSandboxStep } from "#execution/sandbox/initialize-owner-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { SandboxRequestPayload } from "#execution/session-inbox/inbox.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { toErrorMessage } from "#shared/errors.js";

/** The inbox services this internal request using only the owner's committed state. */
export async function handleSandboxRequest(input: {
  readonly cursor: SessionStateCursor;
  readonly message: SandboxRequestPayload;
}): Promise<void> {
  let response;
  try {
    const result = await input.cursor.advance(initializeOwnerSandboxStep);
    response = { state: result.sandboxState };
  } catch (error) {
    response = { error: toErrorMessage(error) };
  }
  await resumeHookStep(input.message.replyTo, response);
}
