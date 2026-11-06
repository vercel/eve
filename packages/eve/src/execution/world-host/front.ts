import { buildConversationContext } from "#channel/conversation-context.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { remoteChildBindingName } from "#execution/child-binding-name.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
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
  assertSessionHistoryReadable,
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
import { AliasTakenError, type Entities } from "#execution/entity/entities.js";
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
  /**
   * Whether a session started with `input` keeps nothing once it ends, as its agent's retention
   * and trace capture decide: its entity is then created to be purged.
   */
  readonly purgesOnEnd?: (input: RunInput) => Promise<boolean>;
}): Runtime {
  const { entities } = input;

  const send = async <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>> => {
    const identified = identifyCommand(command);
    // A session on a World host runs wherever its next activation does: there's no deployment to
    // move it to, so preparing one does nothing, and a session that exists is ready.
    if (identified.kind === "prewarm")
      return (
        (await entities.lookup(token)) === undefined
          ? { status: "no_active_session" }
          : { status: "ready" }
      ) as SessionCommandResult<TCommand>;
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
      const handle = (id: string): RunHandle => {
        let events: ReadableStream | undefined;
        return {
          get events() {
            return (events ??= readSessionEventStream(id));
          },
          sessionId: id,
          ...(identified.delivery !== undefined && { deliveryId: identified.delivery.deliveryId }),
        };
      };
      // A session at the address already (a retried start, or a start that raced another): that
      // one is the session, sent what the input says a conflict sends.
      const existing = async (): Promise<RunHandle | undefined> => {
        const token = identified.continuationToken;
        const found = token === undefined ? undefined : await entities.lookup(token);
        if (found === undefined) return undefined;
        const conflict = identified.continuationConflictCommand;
        if (conflict !== undefined && token !== undefined) await send(token, conflict);
        return handle(found);
      };
      const before = await existing();
      if (before !== undefined) return before;
      // Who the conversation is with, resolved here: its channel's audience classifier is a
      // function, which what the session is created with (JSON) doesn't keep.
      const start: SessionStart = {
        agent: input.agent,
        input:
          identified.inheritedConversation === undefined
            ? {
                ...identified,
                inheritedConversation: buildConversationContext(
                  identified,
                  resolveInstrumentationEnvironment(),
                ),
              }
            : identified,
      };
      try {
        await entities.create(sessionId, {
          aliases: tokens,
          meta: start,
          ...((await input.purgesOnEnd?.(identified)) === true && { purgeOnEnd: true }),
        });
      } catch (error) {
        const raced = error instanceof AliasTakenError ? await existing() : undefined;
        if (raced === undefined) throw error;
        return raced;
      }
      await entities.activation?.wake(sessionId);
      return handle(sessionId);
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
      // Before any bytes: a session whose history is gone fails here, so its route says so.
      await assertSessionHistoryReadable(sessionId);
      return options?.follow === false
        ? readSessionEventHistory(sessionId, options.startIndex, options.signal)
        : readSessionEventStream(sessionId, options?.startIndex, options?.signal);
    },

    async getLineStream(sessionId, options) {
      await assertSessionHistoryReadable(sessionId);
      return options?.follow === false
        ? readSessionRecordHistory(sessionId, options.startIndex)
        : readSessionRecords(sessionId, options?.startIndex);
    },

    async readChildBinding(sessionId, childSessionId) {
      const kept = await entities.value(sessionId, remoteChildBindingName(childSessionId));
      return kept === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(kept)) as RemoteChildBinding);
    },
    async getStreamTailIndex(sessionId) {
      return await readSessionStreamTailIndex(sessionId);
    },
  };
}
