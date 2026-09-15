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
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type Command = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;
type Hook = Awaited<ReturnType<typeof getHookByToken>>;

/** Reported as an inactive session so the channel starts a fresh one. */
export class UnsupportedLegacySessionError extends Error {
  constructor() {
    super("This session predates eve 0.45 and cannot be continued. Start a new session.");
    this.name = "UnsupportedLegacySessionError";
  }
}

/**
 * Oldest driver wire version still accepted. Drivers started before eve 0.45
 * used an unversioned envelope; those sessions report themselves inactive so
 * the channel starts a fresh session instead of misdelivering.
 */
const MIN_LEGACY_WIRE_VERSION = 1;
const MAX_LEGACY_WIRE_VERSION = 7;

/**
 * Finds the pre-cutover hook for a logical token. Once that session has been
 * imported, its current-generation inbox owns delivery and `current` is true.
 */
export async function resolveLegacyInbox(
  token: string,
): Promise<{ hook: Hook; sessionId: string; current: boolean }> {
  const legacy = await getHookByToken(token);
  const metadata = await legacy.metadata;
  const sessionId =
    isObject(metadata) && typeof metadata.sessionId === "string"
      ? metadata.sessionId
      : legacy.runId;
  try {
    const hook = await getHookByToken(sessionInboxHookToken(sessionCommandHookToken(sessionId)));
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
    const metadata = await target.hook.metadata;
    payload = encodeLegacyCommand(
      command,
      isObject(metadata) ? metadata.sessionInboxWireVersion : undefined,
    );
  }
  const hook = await resumeHook(target.hook.token, payload);
  return { ownerRunId: hook.runId, sessionId: Promise.resolve(target.sessionId) };
}

/** Frozen producer projection for driver wire versions 1–7; old consumers validate for themselves. */
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
    const value: Record<string, unknown> = { ...command, version };
    if (command.kind === "cancel" && version < 6) {
      if (command.tasks === true)
        throw new Error("This session cannot cancel owned tasks before import.");
      delete value.tasks;
    }
    return value;
  }
  const payloads = (command.kind === "send" ? [command.payload] : command.payloads).map(
    (payload) => {
      if (payload.task === undefined || version >= 5) return payload;
      const {
        agentRequests: _agentRequests,
        inputRequests: _inputRequests,
        ...task
      } = payload.task;
      return { ...payload, task };
    },
  );
  let caller = command.caller;
  if (caller?.activityObserver !== undefined && version < 7) {
    const { activityObserver, ...rest } = caller;
    if (version < 2) caller = rest;
    else {
      const workIdentity =
        activityObserver.workIdentity === undefined
          ? undefined
          : { ...activityObserver.workIdentity };
      if (workIdentity !== undefined) delete workIdentity.label;
      caller = { ...rest, activityObserver: { ...activityObserver, workIdentity } };
    }
  }
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
    taskDeliveryId: command.taskDeliveryId,
    turnPolicy: command.turnPolicy,
    version,
  };
}
