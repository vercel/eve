import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type {
  SessionCandidate,
  SessionOwnerActivation,
  SessionTransferOutcome,
} from "#execution/session/handoff.js";
import { validateSessionCheckpointStep } from "#execution/session/handoff-steps.js";
import { sessionHandoffMarkerToken } from "#execution/session-inbox/address.js";
import type {
  SessionInbox,
  SessionInboxHandle,
  SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";

/*
 * The release-first handoff that predates forced hook claims. It serves only
 * owners whose run was started on a Workflow spec that cannot be taken from:
 * successors of version 1 sources and imported pre-cutover sessions. Delete
 * this module, the handoff markers, and the ingress retry in
 * `session-inbox/resume.ts` once no such owner can exist.
 */

/** Version 1 sources omit the handoff version. */
export function isLegacyHandoff(input: Pick<HandoffWorkflowEntryInput, "handoffVersion">): boolean {
  return input.handoffVersion === undefined;
}

/** Claims the hooks a version 1 source released before starting this successor. */
export async function adoptReleasedSession(
  input: HandoffWorkflowEntryInput,
  inbox: Pick<SessionInbox, "claimSessionHooks">,
  tokens: readonly string[],
): Promise<void> {
  await validateSessionCheckpointStep({ checkpoint: input.checkpoint });
  await inbox.claimSessionHooks(tokens);
}

/**
 * Releases every hook, then starts the successor, leaving the session unowned
 * until it claims them. Markers let ingress distinguish a session mid-handoff
 * from an address nobody owns, so a concurrent channel delivery retries
 * instead of creating a replacement session on the released alias.
 */
export async function transferReleasedSession(
  candidate: SessionCandidate,
  inbox: SessionInboxHandle,
  activate: () => Promise<SessionOwnerActivation>,
): Promise<SessionTransferOutcome> {
  const markers = candidate.tokens.map((token) =>
    createHook<never>({ token: sessionHandoffMarkerToken(token) }),
  );
  await Promise.all(markers.map((marker) => claimHookOwnership(marker)));
  try {
    const acceptedDuringRelease = await inbox.release();
    if (acceptedDuringRelease.length > 0) {
      await recover(inbox, candidate.tokens, acceptedDuringRelease);
      return { kind: "retained", reason: "accepted-during-release" };
    }
    let acceptedByFailedCandidate: readonly SessionInboxPayload[] = [];
    try {
      const activation = await activate();
      if (activation.kind === "active") return { kind: "transferred" };
      acceptedByFailedCandidate = activation.payloads;
    } catch {
      // The current owner remains authoritative until activation.
    }
    await recover(inbox, candidate.tokens, acceptedByFailedCandidate);
    return { kind: "retained", reason: "activation-failed" };
  } finally {
    await Promise.all(markers.map((marker) => disposeHook(marker)));
  }
}

/** Reclaims the exact hook set and replays payloads accepted while it was released. */
async function recover(
  inbox: SessionInboxHandle,
  tokens: readonly string[],
  payloads: readonly SessionInboxPayload[],
): Promise<void> {
  await inbox.claimSessionHooks(tokens);
  inbox.restore(payloads);
}
