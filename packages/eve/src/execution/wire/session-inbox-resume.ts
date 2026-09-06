import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  SESSION_INBOX_WIRE_VERSION_METADATA_KEY,
  isSessionInboxAddress,
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxAddress,
  type SessionInboxWireTarget,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { getHookByToken, getRawHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type ResumedSessionInboxHook = Awaited<ReturnType<typeof resumeHook>>;

/** Resolves the consumer contract, encodes for it, and resumes that exact hook. */
export async function resumeSessionInbox(
  address: string | SessionInboxAddress,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Promise<ResumedSessionInboxHook> {
  if (typeof address !== "string") {
    if (!isSessionInboxAddress(address)) {
      throw new SessionInboxWireError("Session inbox target has an invalid address.");
    }
    if (!isSessionInboxWireVersion(address.version)) {
      throw new SessionInboxWireError(
        `Session inbox target declares unsupported wire version ${JSON.stringify(address.version)}.`,
      );
    }
    return await resumeHook(
      sessionCommandHookToken(address.sessionId),
      sessionInboxWire.encode(command, { version: address.version }),
    );
  }

  const hook = await getHookByToken(address);
  const target = await resolveSessionInboxWireTarget(hook);
  if (target.version === 0) {
    // A legacy envelope can carry new fields without its consumer understanding them.
    sessionInboxWire.encode(command, { version: 1 });
  }
  return await resumeHook(hook, sessionInboxWire.encode(command, target));
}

type SessionInboxHook = Awaited<ReturnType<typeof getHookByToken>>;

/** Selects the encoder understood by a persisted hook's consumer deployment. */
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
    const stableHook = await getRawHookByToken(stableToken);
    if (stableHook.runId !== hook.runId) {
      throw new SessionInboxWireError(
        `Stable session inbox ${JSON.stringify(stableToken)} belongs to run ${JSON.stringify(stableHook.runId)}, expected ${JSON.stringify(hook.runId)}.`,
      );
    }
    return { variant: "send", version: 0 };
  } catch (error) {
    if (HookNotFoundError.is(error)) return { variant: "deliver", version: 0 };
    throw error;
  }
}
