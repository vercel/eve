import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { SessionCommand, SessionCommandResult } from "#channel/types.js";

/** Assign the delivery before accepting it, so replay and the sender name the same facts. */
export function identifyCommand<T extends SessionCommand>(command: T): T {
  if (command.kind !== "send" || command.delivery !== undefined) return command;
  const channel =
    command.caller === undefined
      ? command.schedule === undefined
        ? "http"
        : "schedule"
      : "subagent";
  return {
    ...command,
    delivery: createChannelDeliveryMetadata({
      channelKind: channel,
      channelName: channel,
      requestId: command.requestId,
    }),
  };
}

/** What a sender hears when the session `sessionId` accepted `command`. */
export function activeCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  sessionId: string,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "reset"
      ? { previousSessionId: sessionId, status: "reset" as const }
      : command.kind === "send" && command.delivery !== undefined
        ? { sessionId, status: "accepted" as const, deliveryId: command.delivery.deliveryId }
        : { sessionId, status: "accepted" as const };
  return result as SessionCommandResult<TCommand>;
}

/** What a sender hears when no session was there to accept `command`. */
export function inactiveCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "send"
      ? { status: "session_not_active" as const }
      : command.kind === "cancel"
        ? { status: "no_active_turn" as const }
        : { status: "no_active_session" as const };
  return result as SessionCommandResult<TCommand>;
}
