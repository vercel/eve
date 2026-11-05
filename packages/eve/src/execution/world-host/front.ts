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
import type { Entities } from "#execution/entity/entities.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { SessionMessage, SessionStart } from "./driver.js";

// The runtime a World host's callers use: it runs nothing. Starting a session creates its entity,
// reached by its addresses, and activates it; a command to a session is sent to the address it
// names, which activates it; reading a session follows its stream on the World. Whichever process
// the activation reaches runs the session (`driver.ts`). So a channel address, an embedded session
// or a schedule over it reaches sessions the way it reaches a deployment's.

export function createFrontRuntime(input: {
  readonly entities: Entities;
  /** The agent the sessions it starts run, by the name the host knows it by. */
  readonly agent: string;
}): Runtime {
  const { entities } = input;

  const send = async <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>> => {
    const identified = identifyCommand(command);
    const reached = await entities.send({ alias: token }, {
      command: identified,
    } satisfies SessionMessage);
    return reached === undefined
      ? inactiveCommandResult(identified)
      : activeCommandResult(identified, reached.key);
  };

  return {
    async createSession(runInput: RunInput): Promise<RunHandle> {
      const sessionId = entities.newKey();
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
      const start: SessionStart = { agent: input.agent, input: identified };
      await entities.create(sessionId, { aliases: tokens, meta: start });
      await entities.activation?.wake(sessionId);
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
      const sessionId = await entities.lookup(continuationToken);
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
