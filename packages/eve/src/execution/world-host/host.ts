import { createChannelAddress } from "#channel/channel-address.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { codeAgentOf } from "#embed/agent.js";
import type { ActivationOutcome, Entities } from "#execution/entity/entities.js";
import { registerFallbackLineStore } from "#execution/hosts.js";
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
import { holdSessionAgent, type CodeAgent } from "#runtime/sessions/session-agent.js";
import type { Delivery } from "#shared/delivery.js";
import type { Answer } from "#shared/input.js";
import { cronFiresAt } from "./cron.js";
import { sessionActivation, type SessionStart } from "./driver.js";
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
  /** The agents its sessions run, by name (`defineAgent({ name })`); unnamed is `"agent"`. */
  readonly agents: readonly DefinedAgent[];
  /** Schedules by name. */
  readonly schedules?: Readonly<Record<string, WorldHostSchedule>>;
  /**
   * How long one delivery runs a session before it hands off to the next, in milliseconds:
   * below the time the function serving `queueHandler()` may run. Default 4 minutes.
   */
  readonly deliveryBudgetMs?: number;
  /** Told how each delivery that ran a session ended, and how long it ran. */
  readonly observe?: (delivery: {
    readonly sessionId: string;
    readonly outcome: ActivationOutcome;
    readonly ms: number;
  }) => void;
}

/** A conversation with a World host's agent, which runs wherever its wakes are delivered. */
export interface WorldSession {
  /** The session's id, once its first message started it. */
  readonly id: string | undefined;
  /** Sends a message; it's kept on the World, and the session woken, before this resolves. */
  send(message: string): Promise<Delivery>;
  /** Answers the session's open requests, such as approvals. */
  respond(answers: readonly Answer[]): Promise<Delivery>;
  /** Cancels the running turn. */
  cancel(): Promise<void>;
  /** The session's events from line `from` (its start, by default), followed on the World. */
  events(options?: {
    readonly from?: number;
    readonly signal?: AbortSignal;
  }): Promise<ReadableStream<SessionStreamEvent>>;
  /** What the session waits on a person for, as its stream records so far. */
  pending(): Promise<readonly Interaction[]>;
}

export interface WorldHost {
  readonly world: QueueWorld;
  /** The runtime sessions of `agent` are reached through: it runs nothing itself. */
  runtime(agent: string): Runtime;
  /** A conversation with `agent`: a new one, or the session `resume` names. */
  session(
    agent: string,
    options: { readonly identity: SessionAuthContext | null; readonly resume?: string },
  ): WorldSession;
  /** The sessions, as the entities they are on the World. */
  readonly entities: Entities;
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
  const agents = new Map<string, CodeAgent>();
  for (const defined of options.agents) {
    const agent = codeAgentOf(defined);
    if (agents.has(agent.id)) throw new Error(`Two agents of this host are named "${agent.id}".`);
    agents.set(agent.id, agent);
  }
  const entities = sessionEntities(world);
  const activation = entities.activation;
  if (activation === undefined) throw new Error("A World host needs a World with a queue.");
  const fronts = new Map<string, Runtime>();
  const runtime = (agent: string): Runtime => {
    if (!agents.has(agent)) throw new Error(`This host has no agent "${agent}".`);
    let front = fronts.get(agent);
    if (front === undefined) fronts.set(agent, (front = createFrontRuntime({ agent, entities })));
    return front;
  };
  const releaseLines = registerFallbackLineStore(entityLineStore(entities));
  let ticker: ReturnType<typeof setTimeout> | undefined;

  const consumer = activation.consumer(
    sessionActivation({
      agent(name) {
        const agent = agents.get(name);
        return agent === undefined
          ? undefined
          : { config: { agent }, release: holdSessionAgent(agent) };
      },
      entities,
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
    return fired;
  };

  return {
    world,
    entities,
    runtime,
    deliver: consumer.deliver,
    tick,
    queueHandler: () => consumer.route(),
    session: (agent, sessionOptions) => worldSession(runtime(agent), entities, sessionOptions),
    async serve() {
      await consumer.serve();
      if (options.schedules === undefined || Object.keys(options.schedules).length === 0) return;
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
    },
  };
}

/** A session's stream as its entity's, for readers in any process. */
function entityLineStore(entities: Entities): SessionLineStore {
  return {
    async assertReadable() {},
    readable: (sessionId, startIndex) => entities.read(sessionId, startIndex),
    tail: async (sessionId) => (await entities.streamLength(sessionId)) - 1,
  };
}

function worldSession(
  runtime: Runtime,
  entities: Entities,
  options: { readonly identity: SessionAuthContext | null; readonly resume?: string },
): WorldSession {
  const auth = options.identity;
  let sessionId = options.resume;
  const ready = (async () => {
    // A resumed session's address is the one it started with.
    const recorded =
      options.resume === undefined
        ? undefined
        : ((await entities.meta(options.resume)) as SessionStart | undefined)?.input
            .continuationToken;
    if (options.resume !== undefined && recorded === undefined)
      throw new Error(`The World holds no session "${options.resume}" to resume.`);
    return createChannelAddress({
      adapter: { kind: "http" },
      channelName: CHANNEL_NAME,
      continuationToken:
        recorded?.startsWith(`${CHANNEL_NAME}:`) === true
          ? recorded.slice(CHANNEL_NAME.length + 1)
          : `embedded-${randomUUID()}`,
      runtime,
    });
  })();
  ready.catch(() => {});
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
      const delivery = await (await ready).send(message, { auth });
      sessionId = delivery.sessionId;
      return delivery;
    },
    async respond(answers) {
      return await (await ready).deliver({ answers }, { auth });
    },
    async cancel() {
      await runtime.dispatchSession({
        command: { deliveryId: `cancel-${randomUUID()}`, kind: "cancel" },
        sessionId: await started(),
      });
    },
    async events(eventOptions = {}) {
      return await runtime.getEventStream(await started(), {
        startIndex: eventOptions.from ?? 0,
        ...(eventOptions.signal !== undefined && { signal: eventOptions.signal }),
      });
    },
    async pending() {
      if (sessionId === undefined) return [];
      const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
      const events: SessionStreamEvent[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read())
        events.push(next.value);
      return openInteractions(foldEvents(emptySessionView(), events));
    },
  };
}
