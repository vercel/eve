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
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type ResumedSessionInboxHook = Awaited<ReturnType<typeof resumeHook>>;

/** Resolves the consumer contract, encodes for it, and resumes that exact hook. */
export async function resumeSessionInbox(
  token: string,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Promise<ResumedSessionInboxHook> {
  if (isStableInboxFastPathCompatible(token, command)) {
    return await resumeHook(
      token,
      sessionInboxWire.encode(command, { variant: "send", version: 0 }),
    );
  }

  const hook = await getHookByToken(token);
  const target = await resolveSessionInboxWireTarget(hook);
  return await resumeHook(hook, sessionInboxWire.encode(command, target));
}

function isStableInboxFastPathCompatible(
  token: string,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): boolean {
  if (!isSessionCommandHookToken(token)) return false;
  if (command.kind === "cancel" && command.tasks === true) return false;
  return !("caller" in command && command.caller?.activityObserver !== undefined);
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
    const stableHook = await getHookByToken(stableToken);
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
