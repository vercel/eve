import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

type Command = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;
type Hook = Awaited<ReturnType<typeof getHookByToken>>;

/** A legacy alias remains owned by the stream anchor after import. */
export async function resolveLegacyInbox(
  token: string,
): Promise<{ hook: Hook; sessionId: string; current: boolean }> {
  token = token.replace(/^eve:inbox:v1:/, "");
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
    const version = isObject(metadata) ? metadata.sessionInboxWireVersion : undefined;
    let variant: "send" | "deliver" = "send";
    if (version === undefined && token !== legacySessionCommandToken(target.sessionId)) {
      try {
        await getHookByToken(legacySessionCommandToken(target.sessionId));
      } catch (error) {
        if (!HookNotFoundError.is(error)) throw error;
        variant = "deliver";
      }
    }
    payload = encodeLegacyCommand(command, version, variant);
  }
  const hook = await resumeHook(target.hook.token, payload);
  return { ownerRunId: hook.runId, sessionId: Promise.resolve(target.sessionId) };
}

/** Frozen producer projection; old consumers perform their own validation. */
export function encodeLegacyCommand(
  command: Command,
  declaredVersion: unknown,
  variant: "send" | "deliver" = "send",
): unknown {
  const version = declaredVersion ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 7)
    throw new Error("Unsupported legacy session inbox version.");
  if (command.kind !== "send" && command.kind !== "deliver") {
    const value: Record<string, unknown> = { ...command };
    if (command.kind === "cancel" && version < 6) {
      if (command.tasks === true)
        throw new Error("This session cannot cancel owned tasks before import.");
      delete value.tasks;
    }
    if (version > 0) value.version = version;
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
  const delivery = {
    auth: command.auth,
    caller,
    deliveryMetadata,
    kind: "deliver",
    payloads,
    requestId: command.requestId,
    taskDeliveryId: command.taskDeliveryId,
    turnPolicy: command.turnPolicy,
  };
  if (version > 0) return { ...delivery, payload: coalesceDeliverPayloads(payloads), version };
  if (variant === "deliver") return delivery;
  const metadata = deliveryMetadata?.find((value) => value.payloadIndex === 0);
  const { payloadIndex: _index, ...source } = metadata ?? {};
  return {
    auth: command.auth,
    caller,
    kind: "send",
    payload: coalesceDeliverPayloads(payloads),
    delivery: metadata === undefined ? undefined : source,
    requestId: command.requestId,
    taskDeliveryId: command.taskDeliveryId,
    turnPolicy: command.turnPolicy,
  };
}

function legacySessionCommandToken(sessionId: string): string {
  return `eve:session:${sessionId}:inbox`;
}
