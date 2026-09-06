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
  isSessionInboxAddress,
  isSessionInboxWireVersion,
  SessionInboxWireError,
  type SessionInboxAddress,
  type SessionInboxWireTarget,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { getHookByToken, getRawHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

const legacyDeliverSchema = sessionInboxWireV1Schema.options[0];
// Task operations need an advertised version, even when the envelope is a legacy send.
const stablePayloadSchema = legacyDeliverSchema.shape.payload
  .unwrap()
  .omit({ task: true })
  .strict();

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

  const stableWire = encodeStableInboxCommand(address, command);
  if (stableWire !== undefined) return await resumeHook(address, stableWire);

  const hook = await getHookByToken(address);
  const target = await resolveSessionInboxWireTarget(hook);
  if (target.version === 0) {
    // A legacy envelope can carry new fields without its consumer understanding them.
    sessionInboxWire.encode(command, { version: 1 });
  }
  return await resumeHook(hook, sessionInboxWire.encode(command, target));
}

/**
 * `{ kind: "send", payload: { message: "hello" } }` can skip the metadata lookup.
 * A payload containing `task` must negotiate, even if it also contains a message.
 */
function encodeStableInboxCommand(
  token: string,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Record<string, unknown> | undefined {
  if (!isSessionCommandHookToken(token) || command.kind === "deliver") return undefined;
  if (command.kind === "send") {
    if (!stablePayloadSchema.safeParse(command.payload).success) return undefined;
    if (!legacyDeliverSchema.shape.caller.safeParse(command.caller).success) return undefined;
  } else if (!sessionInboxWireV1Schema.safeParse({ ...command, version: 1 }).success) {
    return undefined;
  }
  try {
    return sessionInboxWire.encode(command, { variant: "send", version: 0 });
  } catch (error) {
    if (error instanceof SessionInboxWireError) return undefined;
    throw error;
  }
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
