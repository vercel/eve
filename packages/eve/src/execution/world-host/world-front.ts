import { createChannelAddress } from "#channel/channel-address.js";
import type { RunInput, Runtime, SessionAuthContext } from "#channel/types.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import type { Entities } from "#execution/entity/entities.js";
import { registerFallbackLineStore, registerHost } from "#execution/hosts.js";
import { logicalSessionInboxToken } from "#execution/session-inbox/address.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import type { QueueWorld } from "#execution/world/runtime-world.js";
import { sessionEntities } from "#execution/world/session-entities.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  emptySessionView,
  foldEvents,
  openInteractions,
} from "#protocol/session-projection/public-view.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import { randomUUID } from "#platform/uuid.js";
import { parseAnswers } from "#shared/input.js";
import type { SessionHandle } from "#shared/session.js";
import { eveChannelDefinitions, worldHostChannels } from "./channels.js";
import type { SessionMessage, SessionStart } from "./driver.js";
import { createFrontRuntime } from "./front.js";

// A World host's front: what its callers reach sessions through, knowing its agents only by name.
// It creates sessions on the World, sends to them and reads their streams; it runs none of them,
// so it needs no agent definitions. Whichever process the World's queue delivers a session's wake
// to runs it: a World host with the agents' definitions (`host.ts`), here or in another
// deployment on the same World and queue namespace. So a server's routes build a front, its queue
// function a host, and agents built at startup (from a database, per customer) are built only
// where sessions run.

/**
 * An agent a front reaches sessions of: its name, as the hosts that run them know it, or that
 * with what the front decides as a session starts.
 */
export type WorldFrontAgent =
  | string
  | {
      readonly name: string;
      /**
       * The agent's retention: `0` keeps nothing of a session once it ends (its entity is created
       * to be purged). Otherwise, or unset, a session is kept.
       */
      readonly retention?: number;
    };

export interface WorldFrontOptions {
  /** The World that keeps the sessions and delivers their wakes. */
  readonly world: QueueWorld;
  readonly agents: readonly WorldFrontAgent[];
  /** The queue namespace the hosts that run its sessions consume (`WorldHostOptions.queueNamespace`). */
  readonly queueNamespace?: string;
}

/**
 * A conversation with a World host's agent, which runs wherever its wakes are delivered: a
 * `SessionHandle`, as a client's or an embedded session is, so code written against one runs
 * against any. Nothing here holds the session in this process.
 */
export interface WorldHostSession extends SessionHandle {
  /** What the session waits on a person for, as its stream records so far. */
  pending(): Promise<readonly Interaction[]>;
}

export interface WorldFront {
  readonly world: QueueWorld;
  /** The sessions, as the entities they are on the World. */
  readonly entities: Entities;
  /** The runtime sessions of `agent` are reached through: it runs nothing itself. */
  runtime(agent: string): Runtime;
  /**
   * A conversation with `agent`, every call made as `identity`: a new one, created on the World
   * before this resolves (so its `id` is set, and nothing runs until its first message), or the
   * session `resume` names.
   */
  createSession(
    agent: string,
    options: { readonly identity: SessionAuthContext | null; readonly resume?: string },
  ): Promise<WorldHostSession>;
  /**
   * A `fetch` serving eve's own channel for `agent`: the session protocol `eve/client` speaks
   * (`/eve/v1/...`) and the sign-in callback, as a deployment's eve channel serves them. Each
   * request is verified by `auth` (`eve/channels/auth`'s verifiers), and the caller it verifies
   * is the session's identity. Serve it where the client's `baseUrl` points.
   */
  eveChannel(
    agent: string,
    options: Pick<EveChannelConfig, "auth"> & {
      /** Work a route keeps going after its response; a serverless platform's `waitUntil`. */
      readonly waitUntil?: (task: Promise<unknown>) => void;
    },
  ): (request: Request) => Promise<Response>;
  /** Where this process reads sessions' streams: their entities'. */
  readonly lineStore: SessionLineStore;
  close(): Promise<void>;
}

/** The internals a World host gives its front, which knows its agents' definitions. */
export interface WorldFrontInternals {
  /**
   * Whether a session of `agent` started with `input` keeps nothing once it ends, as the session's
   * start will decide it (its agent's retention, or its trace capture); `retention` otherwise.
   */
  readonly purgesOnEnd?: (agent: string, input: RunInput) => Promise<boolean>;
  /** Where a session that isn't an entity of the World's is read: a Workflow run's session. */
  readonly fallbackLineStore?: SessionLineStore;
}

const CHANNEL_NAME = "embedded";

export function createWorldFront(
  options: WorldFrontOptions,
  internals: WorldFrontInternals = {},
): WorldFront {
  const { world } = options;
  const retention = new Map<string, number | undefined>();
  for (const agent of options.agents) {
    const name = typeof agent === "string" ? agent : agent.name;
    if (retention.has(name)) throw new Error(`Two agents of this front are named "${name}".`);
    retention.set(name, typeof agent === "string" ? undefined : agent.retention);
  }
  const entities = sessionEntities(world, options.queueNamespace);
  if (entities.activation === undefined)
    throw new Error("A World host needs a World with a queue.");
  const runtimes = new Map<string, Runtime>();
  const runtime = (agent: string): Runtime => {
    if (!retention.has(agent)) throw new Error(`This host has no agent "${agent}".`);
    let front = runtimes.get(agent);
    if (front === undefined)
      runtimes.set(
        agent,
        (front = createFrontRuntime({
          agent,
          entities,
          purgesOnEnd: async (input) =>
            internals.purgesOnEnd !== undefined
              ? await internals.purgesOnEnd(agent, input)
              : retention.get(agent) === 0,
        })),
      );
    return front;
  };
  // Sessions' streams are read from their entities by everything in this process that reads one,
  // such as eve's channel.
  const lines = holdLineStore(entities, internals.fallbackLineStore);
  // A sign-in callback (`/.well-known/eve/connections/.../callback/...`) resumes the session's
  // address in whichever process the route runs: sent to its entity, so it reaches the session
  // wherever it runs next. Anything else delivered in this process (a run's message to the session
  // it runs for) stays with the routes after this one: the session's activation holds it.
  const releaseRoute = registerHost({
    async deliver(token, payload) {
      if ((payload as { readonly kind?: unknown } | undefined)?.kind !== "authorization-callback")
        return undefined;
      const alias = logicalSessionInboxToken(token) ?? token;
      const sent = await entities.send({ alias }, { deliver: payload } satisfies SessionMessage);
      return sent === undefined ? undefined : "delivered";
    },
    runEnded: () => undefined,
    cancelRun: () => undefined,
  });
  return {
    world,
    entities,
    get lineStore() {
      return lines.held.lineStore;
    },
    runtime,
    createSession: async (agent, sessionOptions) =>
      await worldHostSession(runtime(agent), entities, sessionOptions),
    eveChannel(agent, channelOptions) {
      const definitions = eveChannelDefinitions({ auth: channelOptions.auth });
      return worldHostChannels({
        agentName: agent,
        channels: async () => definitions,
        runtime: runtime(agent),
        ...(channelOptions.waitUntil !== undefined && { waitUntil: channelOptions.waitUntil }),
      });
    },
    async close() {
      lines.release();
      releaseRoute();
    },
  };
}

async function worldHostSession(
  runtime: Runtime,
  entities: Entities,
  options: { readonly identity: SessionAuthContext | null; readonly resume?: string },
): Promise<WorldHostSession> {
  const auth = options.identity;
  // A resumed session's address is the one it started with.
  const recorded =
    options.resume === undefined
      ? undefined
      : ((await entities.meta(options.resume)) as SessionStart | undefined)?.input
          .continuationToken;
  if (options.resume !== undefined && recorded === undefined)
    throw new Error(`The World holds no session "${options.resume}" to resume.`);
  const address = createChannelAddress({
    adapter: { kind: "http" },
    channelName: CHANNEL_NAME,
    continuationToken:
      recorded?.startsWith(`${CHANNEL_NAME}:`) === true
        ? recorded.slice(CHANNEL_NAME.length + 1)
        : `embedded-${randomUUID()}`,
    runtime,
  });
  const session =
    options.resume === undefined
      ? (await address.create({ auth })).session
      : await address.resolveSession();
  if (session === undefined)
    throw new Error(`The World's session "${options.resume}" holds no address.`);
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
    async pending() {
      const reader = (await runtime.getEventStream(id, { follow: false })).getReader();
      const events: SessionStreamEvent[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read())
        events.push(next.value);
      return openInteractions(foldEvents(emptySessionView(), events));
    },
  };
}

/** The line store this realm reads one World's sessions from, and the fronts that hold it. */
interface HeldLineStore {
  lineStore: SessionLineStore;
  fallback: SessionLineStore | undefined;
  unregister: () => void;
  holders: number;
}
const heldLineStores = new WeakMap<Entities, HeldLineStore>();

/**
 * Registers `entities`' line store as this realm's, or holds the one registered: fronts and hosts
 * over the same World in one process (a server's routes and its queue function) share it. One
 * that reads what isn't an entity elsewhere (`fallback`, a host's Workflow) replaces it.
 */
function holdLineStore(
  entities: Entities,
  fallback: SessionLineStore | undefined,
): { readonly held: HeldLineStore; release(): void } {
  let held = heldLineStores.get(entities);
  if (held === undefined) {
    const lineStore = entityLineStore(entities, fallback);
    held = { fallback, holders: 0, lineStore, unregister: registerFallbackLineStore(lineStore) };
    heldLineStores.set(entities, held);
  } else if (fallback !== undefined && held.fallback === undefined) {
    held.unregister();
    held.fallback = fallback;
    held.lineStore = entityLineStore(entities, fallback);
    held.unregister = registerFallbackLineStore(held.lineStore);
  }
  held.holders += 1;
  const holding = held;
  let released = false;
  return {
    held: holding,
    release() {
      if (released) return;
      released = true;
      holding.holders -= 1;
      if (holding.holders > 0) return;
      holding.unregister();
      heldLineStores.delete(entities);
    },
  };
}

/** A session's stream as its entity's, for readers in any process. */
function entityLineStore(entities: Entities, fallback?: SessionLineStore): SessionLineStore {
  // A purged session's stream may have chunks left behind on its World: none of it is read.
  const assertPurgedUnread = async (sessionId: string) => {
    if (await entities.purged(sessionId))
      throw new RunExpiredError("Session history is no longer available.", sessionId, "completed");
  };
  const own: SessionLineStore = {
    assertReadable: assertPurgedUnread,
    readable: (sessionId, startIndex) => entities.read(sessionId, startIndex),
    async tail(sessionId) {
      await assertPurgedUnread(sessionId);
      return (await entities.streamLength(sessionId)) - 1;
    },
  };
  if (fallback === undefined) return own;
  // Whether a session is this host's: it is once it has been, so it's asked once.
  const held = new Set<string>();
  const storeOf = async (sessionId: string): Promise<SessionLineStore> => {
    if (held.has(sessionId)) return own;
    // A key the entities can't hold (a Workflow session's run id) is no entity of theirs.
    const meta = await entities.meta(sessionId).catch(() => undefined);
    if (meta === undefined) return fallback;
    held.add(sessionId);
    return own;
  };
  return {
    assertReadable: async (sessionId) => await (await storeOf(sessionId)).assertReadable(sessionId),
    readable(sessionId, startIndex) {
      // Decided as the stream opens: what's read pipes through once it's known where from.
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      void storeOf(sessionId)
        .then((store) => store.readable(sessionId, startIndex).pipeTo(writable))
        .catch((error: unknown) => writable.abort(error).catch(() => {}));
      return readable;
    },
    tail: async (sessionId) => await (await storeOf(sessionId)).tail(sessionId),
  };
}
