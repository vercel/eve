import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  isSessionCommandHookToken,
  sessionCommandHookToken,
} from "#execution/session-command-token.js";
import {
  SESSION_INBOX_WIRE_VERSION_METADATA_KEY,
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxWireTarget,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { getHookByToken, getHookRecordByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type ResumedSessionInboxHook = Awaited<ReturnType<typeof resumeHook>>;

/** Sends a stable envelope; only parent-owned task cancellation needs negotiation. */
export async function resumeSessionInbox(
  token: string,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Promise<ResumedSessionInboxHook> {
  if (command.kind === "cancel" && command.tasks === true) {
    const hook = await getHookByToken(token);
    const target = await resolveSessionInboxWireTarget(hook);
    return await resumeHook(hook, sessionInboxWire.encode(command, target));
  }

  if (isSessionCommandHookToken(token)) {
    return await resumeHook(token, sessionInboxWire.encodeCompatible(command, "send"));
  }

  const hook = await getHookRecordByToken(token);
  const variant = await resolveDeliveryVariant(hook);
  // Resume the inspected hook so alias reuse cannot redirect the delivery to
  // a different owner after choosing its historical envelope.
  return await resumeHook(hook, sessionInboxWire.encodeCompatible(command, variant));
}

async function resolveDeliveryVariant(
  hook: Awaited<ReturnType<typeof getHookRecordByToken>>,
): Promise<"deliver" | "send"> {
  // A stamp's presence identifies the versioned-decoder cohort. Reading its
  // encrypted value is unnecessary: all of those decoders accept `deliver`.
  if (hook.metadata !== undefined) return "deliver";
  const stableToken = sessionCommandHookToken(hook.runId);
  try {
    const stable = await getHookRecordByToken(stableToken);
    if (stable.runId !== hook.runId) {
      throw new SessionInboxWireError(
        `Stable session inbox ${JSON.stringify(stableToken)} belongs to another run.`,
      );
    }
    return stable.metadata === undefined ? "send" : "deliver";
  } catch (error) {
    if (HookNotFoundError.is(error)) return "deliver";
    throw error;
  }
}

type SessionInboxHook = Awaited<ReturnType<typeof getHookByToken>>;

/** Selects the capability-dependent control encoder for a pinned parent. */
export async function resolveSessionInboxWireTarget(
  hook: SessionInboxHook,
): Promise<SessionInboxWireTarget> {
  const metadata = isObject(hook.metadata) ? hook.metadata : undefined;
  if (metadata !== undefined && SESSION_INBOX_WIRE_VERSION_METADATA_KEY in metadata) {
    const version = metadata[SESSION_INBOX_WIRE_VERSION_METADATA_KEY];
    if (isSessionInboxWireVersion(version)) return { version };
    throw new SessionInboxWireError(
      `Session inbox target declares unsupported wire version ${JSON.stringify(version)}.`,
    );
  }

  const stableToken = sessionCommandHookToken(hook.runId);
  if (hook.token === stableToken) return { variant: "send", version: 0 };

  try {
    const stableHook = await getHookByToken(stableToken);
    if (stableHook.runId !== hook.runId) {
      throw new SessionInboxWireError(
        `Stable session inbox ${JSON.stringify(stableToken)} belongs to run ${JSON.stringify(stableHook.runId)}, expected ${JSON.stringify(hook.runId)}.`,
      );
    }
    const metadata = isObject(stableHook.metadata) ? stableHook.metadata : undefined;
    if (metadata !== undefined && SESSION_INBOX_WIRE_VERSION_METADATA_KEY in metadata) {
      return await resolveSessionInboxWireTarget(stableHook);
    }
    return { variant: "send", version: 0 };
  } catch (error) {
    if (HookNotFoundError.is(error)) return { variant: "deliver", version: 0 };
    throw error;
  }
}
