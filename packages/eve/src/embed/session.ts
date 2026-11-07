import { randomUUID } from "node:crypto";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Session } from "#channel/session.js";
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
import { parseAnswers } from "#shared/input.js";
import type { SessionHandle } from "#shared/session.js";

// One conversation with an agent defined in code, running in this process: the same session loop,
// approvals, history, and stream a deployed agent has, behind the same `SessionHandle` as
// `eve/client`'s `ClientSession`. Where a client session sends over HTTP, this one goes straight to
// the runtime, through the session handle a channel uses (`channel/session.ts`). It adds what only
// a session run here has: a checkpoint to restore it from, and stopping its runtime, with or
// without ending it. The session is a run on a World: in this process's memory by default, or the
// one given, which keeps it as it runs so `createSession(agent, { world, resume: id })` continues
// it in another process. Its subagents, tasks and workflow tools run in this process too.

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
   * Continues the session `world` holds under this id. A session saved mid-turn continues that
   * turn from its last step; the step that was running runs again, and the model reads which of
   * its calls may have run.
   */
  readonly resume?: string;
  /** Continues the session a checkpoint recorded, under its id. */
  readonly restore?: SessionSnapshot;
}

/**
 * A session running in this process: the `SessionHandle` every session has (`send`, `respond`,
 * `cancel`, `clear`, `compact`, `end`, `stream`), and what only a session run here has.
 */
export interface EmbeddedSession extends SessionHandle {
  /**
   * The session as JSON-safe data that `createSession(agent, { restore })` continues, here or in
   * another process. It waits for a running step to return (a model call, or a long tool call);
   * a session mid-step is on its World at any moment, and `resume` continues it from there.
   */
  checkpoint(): Promise<SessionSnapshot>;
  /** What the session waits on a person for, such as approvals a restored session still asks. */
  pending(): Promise<readonly Interaction[]>;
  /**
   * Ends the session (its turn is cancelled, the subagents it opened end with it, its sandbox is
   * released, and its stream records the end), then stops its runtime.
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

/**
 * Starts a conversation in this process with the agent `defineAgent({ ... })` returned, or
 * continues one a World or a checkpoint kept.
 */
export async function createSession(
  defined: DefinedAgent,
  options: EmbeddedSessionOptions,
): Promise<EmbeddedSession> {
  const agent = codeAgentOf(defined);
  const auth = options.identity;
  // Its steps resolve the agent by id; the session holds it until it stops.
  const release = holdSessionAgent(agent);
  const runtime = createInProcessRuntime(
    { agent },
    options.world === undefined ? {} : { world: options.world },
  );
  try {
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
    let session: Session | undefined;
    if (restore === undefined) {
      session = (await address.create({ auth })).session;
    } else {
      await runtime.restore(restore);
      session = await address.resolveSession();
      if (session === undefined)
        throw new Error(`The restored session "${restore.sessionId}" holds no address.`);
    }
    return embeddedSession(session, { auth, release, runtime });
  } catch (error) {
    await runtime.dispose().catch(() => {});
    release();
    throw error;
  }
}

/** `session` as an embedded session: every call made as `auth`, beside its runtime. */
function embeddedSession(
  session: Session,
  input: {
    readonly auth: SessionAuthContext | null;
    readonly release: () => void;
    readonly runtime: ReturnType<typeof createInProcessRuntime>;
  },
): EmbeddedSession {
  const { auth, release, runtime } = input;
  const { id } = session;
  return {
    id,
    send: async (message, sendOptions = {}) =>
      await session.send(message, { ...sendOptions, auth }),
    respond: async (answers, respondOptions = {}) =>
      await session.respond(parseAnswers(answers), { ...respondOptions, auth }),
    cancel: async () => await session.cancel({ auth }),
    clear: async () => await session.clear({ auth }),
    compact: async () => await session.compact({ auth }),
    end: async () => await session.end({ auth }),
    stream: (streamOptions) => session.stream(streamOptions),
    async checkpoint() {
      return await runtime.snapshot(id);
    },
    async pending() {
      const reader = (await runtime.getEventStream(id, { follow: false })).getReader();
      const events: SessionStreamEvent[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read())
        events.push(next.value);
      return openInteractions(foldEvents(emptySessionView(), events));
    },
    async close() {
      try {
        await runtime.end(id);
        await runtime.dispose();
      } finally {
        release();
      }
    },
    async suspend() {
      try {
        // Stopped at once, so the World keeps the session as it is now.
        await runtime.dispose();
      } finally {
        release();
      }
    },
  };
}
