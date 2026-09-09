import { createSessionResources } from "#execution/session/resources.js";
import {
  initializeSessionResources,
  publishSessionDescriptor,
  sessionDirectory,
} from "#execution/session/directory.js";
import type { SessionResources } from "#execution/session/resources.js";
import { dispatchTurn } from "#execution/session/dispatch.js";
import type { AcceptedSubmission } from "#execution/turn/types.js";

export async function initializeHolderStep(
  runId: string,
  eventId: string,
): Promise<SessionResources> {
  "use step";
  const resources = createSessionResources(runId, eventId);
  await initializeSessionResources(resources);
  return resources;
}

export async function redirectHolderStep(
  runId: string,
  ownerRunId: string,
  submission: AcceptedSubmission,
): Promise<void> {
  "use step";
  const resources = await sessionDirectory.resolveHolder(ownerRunId);
  await dispatchTurn(resources, submission);
  await publishSessionDescriptor(runId, resources);
}
