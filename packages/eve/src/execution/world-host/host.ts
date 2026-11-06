import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import { createChannelAddress } from "#channel/channel-address.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { codeAgentOf } from "#embed/agent.js";
import type { ActivationOutcome, Entities } from "#execution/entity/entities.js";
import {
  installDurableHost,
  installedDurableHost,
  registerFallbackLineStore,
  registerHost,
  uninstallDurableHost,
  type DurableHost,
} from "#execution/hosts.js";
import { logicalSessionInboxToken } from "#execution/session-inbox/address.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import type { QueueWorld, WorldQueueDelivery } from "#execution/world/runtime-world.js";
import { sessionEntities } from "#execution/world/session-entities.js";
import { createLogger, logError } from "#internal/logging.js";
import { randomUUID } from "node:crypto";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import {
  emptySessionView,
  foldEvents,
  openInteractions,
} from "#protocol/session-projection/public-view.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { DefinedAgent } from "#public/definitions/agent.js";
import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { holdSessionAgent, type CodeAgent } from "#runtime/sessions/session-agent.js";
import { parseAnswers } from "#shared/input.js";
import type { SessionHandle } from "#shared/session.js";
import { handleCallback } from "#compiled/@vercel/queue/index.js";
import { createScheduleOccurrenceConsumer } from "#internal/schedules/occurrence-consumer.js";
import { worldHostChannels } from "./channels.js";
import { cronFiresAt } from "./cron.js";
import { worldDurableHost } from "./durable-host.js";
import { fireDueSchedules } from "./dynamic-schedules.js";
import { registerWorldScheduleStore, worldScheduleStore } from "./schedule-store.js";
import { sessionActivation, type SessionMessage, type SessionStart } from "./driver.js";
import { prepareInitialEntry } from "#execution/initial-entry.js";
import { createFrontRuntime } from "./front.js";

// A World host (experimental): agents defined in code, whose sessions run only when something
// arrives for them. Each session is a durable entity (`#execution/entity`): its entity keeps it,
// a message or its alarm activates it, and whichever process the activation reaches runs it
// until it waits again (`driver.ts`). No process holds a session between activations, so a
// session waits a day on an approval, or on a timer, at no cost.
//   - Anything that talks to a session (a script, an HTTP route, a schedule) goes through the
//     host's runtime for its agent, which creates entities and sends to them (`front.ts`).
//   - Activations are consumed where the World's queue delivers them: in this process for a
//     local or Postgres World (`serve`), or at a route that serves `queueHandler()` for Vercel's.
//   - Schedules fire on `tick`, once per minute and occurrence across every process (`once`):
//     `serve` ticks each minute, and on Vercel a cron route calls it.

const log = createLogger("execution.world-host");

/** One schedule of a World host: `defineSchedule`'s, for sessions of the agent `agent` names. */
export interface WorldHostSchedule {
  readonly agent: string;
  readonly schedule: ScheduleDefinition;
}

export interface WorldHostOptions {
  /** The World that keeps the sessions and delivers their wakes. */
  readonly world: QueueWorld;
  /** The agents defined in code its sessions run, by name (`defineAgent({ name })`); unnamed is `"agent"`. */
  readonly agents?: readonly DefinedAgent[];
  /**
   * The agents compiled from files its sessions run, by the name each is known by here: where
   * each one's compiled artifacts are (a build's, or the ones bundled into this server).
   */
  readonly compiledAgents?: Readonly<Record<string, RuntimeCompiledArtifactsSource>>;
  /** Schedules by name. */
  readonly schedules?: Readonly<Record<string, WorldHostSchedule>>;
  /**
   * How long one delivery runs a session before it hands off to the next, in milliseconds:
   * below the time the function serving `queueHandler()` may run. Default 4 minutes.
   */
  readonly deliveryBudgetMs?: number;
  /**
   * Where the server routes eve's callbacks (`/.well-known/eve/...`), which sign-in links name:
   * its origin, such as a deployment's URL. Without one, a tool that needs a sign-in can't ask.
   */
  readonly callbackBaseUrl?: string;
  /**
   * Workflow, for what a World host doesn't run itself: a deployment's authored workflow tools,
   * whose runs it starts there (`startRun`); their hooks, status and cancelling, and connection
   * event watches, are Workflow's (`host`, which this host's durable host goes on to).
   */
  readonly workflow?: {
    readonly host: DurableHost;
    readonly startRun: StartWorkflowToolRun;
  };
  /**
   * The queue namespace its activations travel in: a deployed agent's own (its queue function's
   * trigger names it). A default shared by World hosts otherwise.
   */
  readonly queueNamespace?: string;
  /** Told how each delivery that ran a session ended, and how long it ran. */
  readonly observe?: (delivery: {
    readonly sessionId: string;
    readonly outcome: ActivationOutcome;
    readonly ms: number;
  }) => void;
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

export interface WorldHost {
  readonly world: QueueWorld;
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
  /** The sessions, as the entities they are on the World. */
  readonly entities: Entities;
  /**
   * A `fetch` serving the channels of the agent compiled from files named `agent`: its own, and
   * the framework's (eve's channel, the sign-in callback). Serve it at the server's root.
   */
  /**
   * The consumer route of the Vercel Schedules occurrences of the agent compiled from files named
   * `agent`: serve it at `/.well-known/eve/v1/schedules/consumer`, a queue trigger of the agent's
   * schedule topic. Occurrences start sessions on this host.
   */
  scheduleConsumer(agent: string): (request: Request) => Promise<Response>;
  channels(
    agent: string,
    options?: { readonly waitUntil?: (task: Promise<unknown>) => void },
  ): (request: Request) => Promise<Response>;
  /**
   * Handles one queue delivery: runs the session it activates until it waits, or continues it
   * in the next delivery near the deadline.
   */
  deliver(message: unknown, delivery: WorldQueueDelivery): Promise<unknown>;
  /** The route handler of a World that delivers wakes over HTTP, such as Vercel's. */
  queueHandler(): (request: Request) => Promise<Response>;
  /** Consumes wakes in this process (a local or Postgres World) and ticks schedules each minute. */
  serve(): Promise<void>;
  /** Fires the schedules due in the minute `at` falls in, each once across processes. */
  tick(at?: Date): Promise<readonly string[]>;
  close(): Promise<void>;
}

const CHANNEL_NAME = "embedded";
export function createWorldHost(options: WorldHostOptions): WorldHost {
  const { world } = options;
  const budgetMs = options.deliveryBudgetMs ?? 4 * 60_000;
  type HostedAgent =
    | { readonly code: CodeAgent }
    | { readonly compiled: RuntimeCompiledArtifactsSource };
  const agents = new Map<string, HostedAgent>();
  const add = (name: string, agent: HostedAgent) => {
    if (agents.has(name)) throw new Error(`Two agents of this host are named "${name}".`);
    agents.set(name, agent);
  };
  for (const defined of options.agents ?? []) {
    const agent = codeAgentOf(defined);
    add(agent.id, { code: agent });
  }
  for (const [name, source] of Object.entries(options.compiledAgents ?? {}))
    add(name, { compiled: source });
  const entities = sessionEntities(world, options.queueNamespace);
  const activation = entities.activation;
  if (activation === undefined) throw new Error("A World host needs a World with a queue.");
  const fronts = new Map<string, Runtime>();
  const runtime = (agent: string): Runtime => {
    if (!agents.has(agent)) throw new Error(`This host has no agent "${agent}".`);
    let front = fronts.get(agent);
    if (front === undefined)
      fronts.set(
        agent,
        (front = createFrontRuntime({
          agent,
          entities,
          // As the session's start will decide it: its agent's retention, or its trace capture.
          async purgesOnEnd(input) {
            const hosted = agents.get(agent)!;
            const config =
              "compiled" in hosted
                ? { compiledArtifactsSource: hosted.compiled }
                : { agent: hosted.code };
            const release = "code" in hosted ? holdSessionAgent(hosted.code) : () => {};
            try {
              return (await prepareInitialEntry(config, input)).entry.retention === 0;
            } finally {
              release();
            }
          },
        })),
      );
    return front;
  };
  // A session this host doesn't hold (one a Workflow run opened, as a workflow tool's `ctx.agent`
  // does) is read where it lives: Workflow's, when this host wraps it.
  const lineStore = entityLineStore(entities, options.workflow?.host.lineStore);
  const releaseLines = registerFallbackLineStore(lineStore);
  // What no route here holds goes to the World, unless this realm has a durable host already
  // (Workflow's, in a process that also runs a deployment's sessions).
  const durable = worldDurableHost({
    entities,
    lineStore,
    runtimeFor(source) {
      const compiled = [...agents].filter(([, agent]) => "compiled" in agent);
      const same = compiled.find(
        ([, agent]) =>
          "compiled" in agent && JSON.stringify(agent.compiled) === JSON.stringify(source),
      );
      const name = same?.[0] ?? (compiled.length === 1 ? compiled[0]![0] : undefined);
      return name === undefined ? undefined : runtime(name);
    },
    ...(options.workflow !== undefined && { fallback: options.workflow.host }),
  });
  // It replaces Workflow's, which it goes on to; a later install of Workflow's keeps it.
  const holder = installedDurableHost();
  if (holder === undefined || holder.name === durable.wraps) installDurableHost(durable);
  // Dynamic schedules (`worldScheduleProvider`) are kept on this World, and fired on `tick`.
  const scheduleStore = worldScheduleStore(world);
  const releaseSchedules = registerWorldScheduleStore(scheduleStore);
  const compiledAgents = Object.entries(options.compiledAgents ?? {}).map(([name, source]) => ({
    name,
    source,
  }));
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
  let ticker: ReturnType<typeof setTimeout> | undefined;

  const consumer = activation.consumer(
    sessionActivation({
      agent(name) {
        const agent = agents.get(name);
        if (agent === undefined) return undefined;
        if ("compiled" in agent)
          return { config: { compiledArtifactsSource: agent.compiled }, release: () => {} };
        return { config: { agent: agent.code }, release: holdSessionAgent(agent.code) };
      },
      ...(options.callbackBaseUrl !== undefined && { callbackBaseUrl: options.callbackBaseUrl }),
      entities,
      runtime: (name) => runtime(name),
      ...(options.workflow !== undefined && { startDurableRun: options.workflow.startRun }),
      world,
    }),
    {
      budgetMs,
      ...(options.observe !== undefined && {
        observe: ({ key, ms, outcome }) => options.observe!({ ms, outcome, sessionId: key }),
      }),
    },
  );

  const tick: WorldHost["tick"] = async (at = new Date()) => {
    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    const fired: string[] = [];
    for (const [name, { agent, schedule }] of Object.entries(options.schedules ?? {})) {
      if (!cronFiresAt(schedule.cron, at) || !(await entities.once(name, minute))) continue;
      const dispatcher = new ScheduleDispatcher({ channels: [], runtime: runtime(agent) });
      try {
        const result = await dispatcher.trigger({
          scheduleId: name,
          ...(schedule.content !== undefined && { markdown: schedule.content }),
          ...(schedule.run !== undefined && { run: schedule.run }),
        });
        await Promise.allSettled(result.waitUntilTasks);
        fired.push(name);
      } catch (error) {
        logError(log, `schedule "${name}" failed`, error);
      }
    }
    if (compiledAgents.length > 0)
      fired.push(
        ...(await fireDueSchedules({
          agents: compiledAgents,
          at,
          runtime,
          store: scheduleStore,
        })),
      );
    return fired;
  };

  return {
    world,
    entities,
    runtime,
    deliver: consumer.deliver,
    tick,
    queueHandler: () => consumer.route(),
    createSession: async (agent, sessionOptions) =>
      await worldHostSession(runtime(agent), entities, sessionOptions),
    scheduleConsumer(agent) {
      const hosted = agents.get(agent);
      if (hosted === undefined || !("compiled" in hosted))
        throw new Error(`This host has no agent compiled from files named "${agent}".`);
      const { handler, retry } = createScheduleOccurrenceConsumer({
        compiledArtifactsSource: () => hosted.compiled,
        runtime: () => runtime(agent),
      });
      return handleCallback(handler, { retry });
    },
    channels(agent, channelOptions = {}) {
      const hosted = agents.get(agent);
      if (hosted === undefined || !("compiled" in hosted))
        throw new Error(`This host has no agent compiled from files named "${agent}".`);
      return worldHostChannels({
        agentName: agent,
        compiledArtifactsSource: hosted.compiled,
        runtime: runtime(agent),
        ...(channelOptions.waitUntil !== undefined && { waitUntil: channelOptions.waitUntil }),
      });
    },
    async serve() {
      await consumer.serve();
      const ticks = Object.keys(options.schedules ?? {}).length > 0 || compiledAgents.length > 0;
      if (!ticks) return;
      const arm = (): void => {
        ticker = setTimeout(
          () => {
            void tick().catch((error: unknown) => logError(log, "schedule tick failed", error));
            arm();
          },
          60_000 - (Date.now() % 60_000) + 50,
        );
      };
      arm();
    },
    async close() {
      if (ticker !== undefined) clearTimeout(ticker);
      releaseLines();
      releaseRoute();
      uninstallDurableHost(durable);
      releaseSchedules();
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
