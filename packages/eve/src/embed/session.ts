import { randomUUID } from "node:crypto";

import { createChannelAddress } from "#channel/channel-address.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import type { SessionSnapshot } from "#execution/in-process/snapshot.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  emptySessionView,
  foldEvents,
  openInteractions,
} from "#protocol/session-projection/public-view.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import { codeAgentOf } from "#embed/agent.js";
import type { DefinedAgent } from "#public/definitions/agent.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";
import type { Delivery } from "#shared/delivery.js";
import type { Answer } from "#shared/input.js";

// One conversation with an agent defined in code, running in this process (internal): the same
// session loop, approvals, history, and stream a deployed agent has. The session is a run on a
// World: in this process's memory by default, or the one given, which keeps it as it runs so
// `createSession(agent, { world, resume: id })` continues it in another process. Its subagents,
// tasks and workflow tools run in this process too, beside it.

export interface EmbeddedSessionOptions {
  /**
   * Who the session acts as, which approvals and `ctx.session.auth` read as they read a deployed
   * caller. There's no default: `null` is no one in particular.
   */
  readonly identity: SessionAuthContext | null;
  /**
   * The World the session is kept on as it runs: each accepted message before it's accepted,
   * each stream line as it's written, and the rest at every step. After a crash,
   * `createSession(agent, { world, resume: id })` continues it, a turn the crash cut off
   * included. In this process's memory by default.
   */
  readonly world?: RuntimeWorld;
  /**
   * Continues the session `world` holds under this id, at its address. A session saved mid-turn
   * continues that turn from its last step; the step that was running runs again, and the model
   * reads which of its calls may have run.
   */
  readonly resume?: string;
  /** Continues the session a snapshot recorded, under its id and address. */
  readonly restore?: SessionSnapshot;
}

export interface EmbeddedSession {
  /** The session's id, once its first message started it. */
  readonly id: string | undefined;
  /** Sends a message; the delivery streams the turn it starts or joins. */
  send(message: string): Promise<Delivery>;
  /** Answers the session's open requests, such as approvals. */
  respond(answers: readonly Answer[]): Promise<Delivery>;
  /** Cancels the running turn. */
  cancel(): Promise<void>;
  /**
   * The session as JSON-safe data that `createSession(agent, { restore })` continues, here or in
   * another process, once its first message started it. It waits for a running step to return
   * (a model call, or a long tool call); a session mid-step is on its World at any moment, and
   * `resume` continues it from there.
   */
  snapshot(): Promise<SessionSnapshot>;
  /** What the session waits on a person for, such as approvals a restored session still asks. */
  pending(): Promise<readonly Interaction[]>;
  /**
   * The session's events from line `from` (its start, by default) as they're written, until
   * `signal` aborts: such as a turn a restore continues.
   */
  events(options?: {
    readonly from?: number;
    readonly signal?: AbortSignal;
  }): Promise<ReadableStream<SessionStreamEvent>>;
  /**
   * Ends the session: its turn is cancelled, the subagents it opened end with it, its sandbox
   * is released, and its stream (on its World too) records the end. Then stops its runtime.
   */
  close(): Promise<void>;
  /**
   * Stops the session here without ending it, as when the process quits: the World it was given
   * keeps it as it was, with its sandbox files and the runs it started, and
   * `createSession(agent, { world, resume: id })` continues it. Without a World of its own, the
   * session ends.
   */
  suspend(): Promise<void>;
}

const CHANNEL_NAME = "embedded";

/** Starts a conversation in this process with the agent `defineAgent({ ... })` returned. */
export function createSession(
  defined: DefinedAgent,
  options: EmbeddedSessionOptions,
): EmbeddedSession {
  const agent = codeAgentOf(defined);
  const auth = options.identity;
  // Its steps resolve the agent by id; the session holds it until it closes.
  const release = holdSessionAgent(agent);
  const runtime = createInProcessRuntime(
    { agent },
    options.world === undefined ? {} : { world: options.world },
  );
  let sessionId = options.restore?.sessionId ?? options.resume;
  // The session to continue, if any, then its address: a saved session records its token.
  const ready = (async () => {
    const restore =
      options.restore ??
      (options.resume === undefined ? undefined : await runtime.load(options.resume));
    if (options.resume !== undefined && restore === undefined)
      throw new Error(`The World holds no session "${options.resume}" to resume.`);
    // The address namespaces its token by channel; a saved session records the namespaced one.
    const recordedToken = restore?.checkpoint.serializedContext["eve.continuationToken"];
    const address = createChannelAddress({
      adapter: { kind: "http" },
      channelName: CHANNEL_NAME,
      continuationToken:
        typeof recordedToken === "string" && recordedToken.startsWith(`${CHANNEL_NAME}:`)
          ? recordedToken.slice(CHANNEL_NAME.length + 1)
          : `embedded-${randomUUID()}`,
      runtime,
    });
    if (restore !== undefined) await runtime.restore(restore);
    return address;
  })();
  // A failed resume rejects each call that waits on it, not the process.
  ready.catch(() => {});
  const restoring =
    options.restore === undefined && options.resume === undefined ? undefined : ready;
  const started = async (): Promise<string> => {
    await ready;
    if (sessionId === undefined) throw new Error("The session starts with its first message.");
    return sessionId;
  };

  return {
    get id() {
      return sessionId;
    },
    async send(message) {
      const address = await ready;
      const delivery = await address.send(message, { auth });
      sessionId = delivery.sessionId;
      return delivery;
    },
    async respond(answers) {
      const address = await ready;
      return await address.deliver({ answers }, { auth });
    },
    async snapshot() {
      return await runtime.snapshot(await started());
    },
    async pending() {
      await restoring;
      if (sessionId === undefined) return [];
      const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
      const events: SessionStreamEvent[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read())
        events.push(next.value);
      return openInteractions(foldEvents(emptySessionView(), events));
    },
    async events(eventOptions = {}) {
      return await runtime.getEventStream(await started(), {
        startIndex: eventOptions.from ?? 0,
        ...(eventOptions.signal !== undefined && { signal: eventOptions.signal }),
      });
    },
    async cancel() {
      await restoring;
      if (sessionId === undefined) return;
      await runtime.dispatchSession({
        command: { deliveryId: `cancel-${randomUUID()}`, kind: "cancel" },
        sessionId,
      });
    },
    async close() {
      try {
        await restoring?.catch(() => {});
        if (sessionId !== undefined) await runtime.end(sessionId);
        await runtime.dispose();
      } finally {
        release();
      }
    },
    async suspend() {
      try {
        // Stopped at once, so the World keeps the session as it is now.
        await (restoring === undefined
          ? runtime.dispose()
          : restoring.catch(() => {}).then(() => runtime.dispose()));
      } finally {
        release();
      }
    },
  };
}
