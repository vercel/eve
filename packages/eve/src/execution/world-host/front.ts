import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { QueueWorld } from "#execution/world/runtime-world.js";
import { createUlid } from "#shared/ulid.js";
import { createWorldSession, sendToAddress, sessionAt } from "./addresses.js";

// The runtime a World host's callers use: it runs nothing. Starting a session writes it on the
// World and wakes it; a command to a session is written at its address and wakes it; reading a
// session follows its stream on the World. Whichever process the wake reaches runs the session
// (`driver.ts`). So a channel address, an embedded session or a schedule over it reaches sessions
// the way it reaches a deployment's.

export function createFrontRuntime(input: {
  readonly world: QueueWorld;
  /** The agent the sessions it starts run, by the name the host knows it by. */
  readonly agent: string;
}): Runtime {
  const { world } = input;

  const send = async <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>> => {
    const identified = identifyCommand(command);
    const reached = await sendToAddress(world, token, identified);
    return reached === undefined
      ? inactiveCommandResult(identified)
      : activeCommandResult(identified, reached.sessionId);
  };

  return {
    async createSession(runInput: RunInput): Promise<RunHandle> {
      const sessionId = `session_${createUlid()}`;
      // Identified here, as the host that starts it would, so the caller holds its delivery id.
      const identified: RunInput =
        runInput.input.message !== undefined && runInput.delivery === undefined
          ? {
              ...runInput,
              delivery: createChannelDeliveryMetadata({
                channelKind: runInput.adapter.kind,
                channelName: runInput.channelName ?? runInput.adapter.kind,
                requestId: runInput.requestId,
              }),
            }
          : runInput;
      const tokens = [
        sessionCommandHookToken(sessionId),
        ...(identified.continuationToken === undefined ? [] : [identified.continuationToken]),
      ];
      await createWorldSession(world, sessionId, { agent: input.agent, input: identified }, tokens);
      let events: ReadableStream | undefined;
      return {
        get events() {
          return (events ??= readSessionEventStream(sessionId));
        },
        sessionId,
        ...(identified.delivery !== undefined && { deliveryId: identified.delivery.deliveryId }),
      };
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      dispatch: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await send(dispatch.continuationToken, dispatch.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      dispatch: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await send(sessionCommandHookToken(dispatch.sessionId), dispatch.command);
    },

    async resolveContinuation(continuationToken) {
      const sessionId = await sessionAt(world, continuationToken);
      return sessionId === undefined ? undefined : { sessionId };
    },

    async getEventStream(sessionId, options) {
      return options?.follow === false
        ? readSessionEventHistory(sessionId, options.startIndex, options.signal)
        : readSessionEventStream(sessionId, options?.startIndex, options?.signal);
    },

    async getLineStream(sessionId, options) {
      return options?.follow === false
        ? readSessionRecordHistory(sessionId, options.startIndex)
        : readSessionRecords(sessionId, options?.startIndex);
    },

    async getStreamTailIndex(sessionId) {
      return await readSessionStreamTailIndex(sessionId);
    },
  };
}
