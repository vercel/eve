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
import { AliasTakenError, type Actors } from "#execution/actor/actors.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { SessionMessage, SessionStart } from "./driver.js";

// The runtime a World host's callers use: it runs nothing. Starting a session creates its actor,
// reached by its addresses, and activates it; a command to a session is sent to the address it
// names, which activates it; reading a session follows its stream on the World. Whichever process
// the activation reaches runs the session (`driver.ts`). So a channel address, an embedded session
// or a schedule over it reaches sessions the way it reaches a deployment's.

/** The runtime a World host's callers use, with a start from Workflow's initial entry for tests. */
export interface FrontRuntime extends Runtime {
  /**
   * Starts a session from the initial entry Workflow's `workflowEntry` takes, as a test written
   * against it does: its actor is created, reached by its session addresses and its continuation
   * token, and activated.
   */
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
  ): Promise<{ readonly sessionId: string }>;
}

export function createFrontRuntime(input: {
  readonly actors: Actors;
  /** The agent the sessions it starts run, by the name the host knows it by. */
  readonly agent: string;
  /**
   * Whether a session started with `input` keeps nothing once it ends, as its agent's retention
   * and trace capture decide: its actor is then created to be purged.
   */
  readonly purgesOnEnd?: (input: RunInput) => Promise<boolean>;
}): FrontRuntime {
  const { actors } = input;

  const send = async <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>> => {
    const identified = identifyCommand(command);
    // A session on a World host runs wherever its next activation does: there's no deployment to
    // move it to, so preparing one does nothing, and a session that exists is ready.
    if (identified.kind === "prewarm")
      return (
        (await actors.lookup(token)) === undefined
          ? { status: "no_active_session" }
          : { status: "ready" }
      ) as SessionCommandResult<TCommand>;
    const reached = await actors.send({ alias: token }, {
      command: identified,
    } satisfies SessionMessage);
    // A reset answers once the session let go of its addresses, as Workflow's does, so a message
    // sent after it starts the next session instead of reaching the one that's ending.
    if (reached !== undefined && identified.kind === "reset")
      await addressesReleased(actors, token, reached.key);
    return reached === undefined
      ? inactiveCommandResult(identified)
      : activeCommandResult(identified, reached.key);
  };

  return {
    async startEntry(entry) {
      const sessionId = actors.newKey();
      const token = entry.serializedContext["eve.continuationToken"];
      const tokens = [
        sessionCommandHookToken(sessionId),
        ...(typeof token === "string" && token !== "" ? [token] : []),
      ];
      const start: SessionStart = { agent: input.agent, entry };
      await actors.create(sessionId, { aliases: tokens, meta: start });
      await actors.activation?.wake(sessionId);
      return { sessionId };
    },

    async createSession(runInput: RunInput): Promise<RunHandle> {
      const sessionId = actors.newKey();
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
      const handle = (id: string, claimed = true): RunHandle => {
        let events: ReadableStream | undefined;
        return {
          // As Workflow's handle for a start that lost the address: it created nothing.
          ...(!claimed && { claimedContinuation: false }),
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
        const found = token === undefined ? undefined : await actors.lookup(token);
        if (found === undefined) return undefined;
        const conflict = identified.continuationConflictCommand;
        if (conflict !== undefined && token !== undefined) await send(token, conflict);
        return handle(found, false);
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
        await actors.create(sessionId, {
          aliases: tokens,
          meta: start,
          ...((await input.purgesOnEnd?.(identified)) === true && { purgeOnEnd: true }),
        });
      } catch (error) {
        const raced = error instanceof AliasTakenError ? await existing() : undefined;
        if (raced === undefined) throw error;
        return raced;
      }
      await actors.activation?.wake(sessionId);
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
      const sessionId = await actors.lookup(continuationToken);
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
      const kept = await actors.value(sessionId, remoteChildBindingName(childSessionId));
      return kept === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(kept)) as RemoteChildBinding);
    },
    async getStreamTailIndex(sessionId) {
      return await readSessionStreamTailIndex(sessionId);
    },
  };
}

/** How long a reset waits for its session's addresses, as Workflow's ingress does. */
const RESET_RELEASE_TIMEOUT_MS = 30_000;

/** Resolves once `token` no longer reaches `key`: the session ended and its actor with it. */
async function addressesReleased(actors: Actors, token: string, key: string): Promise<void> {
  const deadline = Date.now() + RESET_RELEASE_TIMEOUT_MS;
  while ((await actors.lookup(token)) === key) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for session "${key}" to release its addresses.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
