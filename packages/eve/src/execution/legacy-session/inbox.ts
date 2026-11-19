import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  assertRunnableSessionOwner,
  lookupSessionOwnerHook,
  resumeRunnableHook,
} from "#execution/session-inbox/owner.js";
import { getHookByToken } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type Command = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;
type Hook = Awaited<ReturnType<typeof getHookByToken>>;

export class UnsupportedLegacySessionError extends Error {
  constructor() {
    super("This session predates eve 0.45 and cannot be continued. Start a new session.");
    this.name = "UnsupportedLegacySessionError";
  }
}

const MIN_LEGACY_WIRE_VERSION = 1;
const MAX_LEGACY_WIRE_VERSION = 7;

export async function resolveLegacyInbox(
  token: string,
): Promise<{ hook: Hook; sessionId: string; current: boolean }> {
  const legacy = await lookupSessionOwnerHook(token);
  const metadata = await legacy.metadata;
  const sessionId =
    isObject(metadata) && typeof metadata.sessionId === "string"
      ? metadata.sessionId
      : legacy.runId;
  try {
    const hook = await lookupSessionOwnerHook(
      sessionInboxHookToken(sessionCommandHookToken(sessionId)),
    );
    return { hook, sessionId, current: true };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    return { hook: legacy, sessionId, current: false };
  }
}

export async function resumeLegacyInbox(token: string, command: Command) {
  const target = await resolveLegacyInbox(token);
  let payload: unknown = command;
  if (!target.current) {
    await assertRunnableSessionOwner({ runId: target.hook.runId, hook: target.hook });
    const metadata = await target.hook.metadata;
    payload = encodeLegacyCommand(
      command,
      isObject(metadata) ? metadata.sessionInboxWireVersion : undefined,
    );
  }
  const hook = await resumeRunnableHook(target.hook.token, payload);
  return { ownerRunId: hook.runId, sessionId: Promise.resolve(target.sessionId) };
}

export function encodeLegacyCommand(command: Command, declaredVersion: unknown): unknown {
  const version = declaredVersion;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < MIN_LEGACY_WIRE_VERSION ||
    version > MAX_LEGACY_WIRE_VERSION
  ) {
    throw new UnsupportedLegacySessionError();
  }
  if (command.kind !== "send" && command.kind !== "deliver") {
    return { ...command, version };
  }
  const payloads = command.kind === "send" ? [command.payload] : command.payloads;
  const caller = command.caller;
  let deliveryMetadata =
    command.kind === "send"
      ? command.delivery === undefined
        ? undefined
        : [{ ...command.delivery, payloadIndex: 0 }]
      : command.deliveryMetadata;
  if (version < 3 && deliveryMetadata !== undefined) {
    deliveryMetadata = deliveryMetadata.map(
      ({ acceptedDeploymentId: _deployment, ...metadata }) => metadata,
    );
  }
  return {
    auth: command.auth,
    caller,
    deliveryMetadata,
    kind: "deliver",
    payload: coalesceDeliverPayloads(payloads),
    payloads,
    requestId: command.requestId,
    turnPolicy: command.turnPolicy,
    version,
  };
}
