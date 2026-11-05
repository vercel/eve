import { createChannelAddress } from "#channel/channel-address.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { codeAgentOf } from "#embed/agent.js";
import { registerFallbackLineStore } from "#execution/hosts.js";
import type { QueueWorld, WorldQueueDelivery } from "#execution/world/runtime-world.js";
import { createLogger, logError } from "#internal/logging.js";
import { randomUUID } from "#platform/uuid.js";
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
import { isEntityConflict } from "#shared/run-errors.js";
import { readSessionLog } from "./addresses.js";
import { cronFiresAt } from "./cron.js";
import { driveSession, type DriveOutcome } from "./driver.js";
import { createFrontRuntime } from "./front.js";
import { sessionOfWake, WORLD_HOST_QUEUE_PREFIX } from "./wake.js";
import { worldLineStore } from "./world-lines.js";

// A World host (experimental): agents defined in code, whose sessions run only when something
// arrives for them. A World keeps each session, its queue wakes it, and whichever process
// receives the wake runs it until it waits again (`driver.ts`). No process holds a session
// between wakes, so a session waits a day on an approval, or on a timer, at no cost.
//   - Anything that talks to a session (a script, an HTTP route, a schedule) goes through the
//     host's runtime for its agent, which writes to the World and wakes (`front.ts`).
//   - Wakes are consumed where the World's queue delivers them: in this process for a local or
//     Postgres World (`serve`), or at a route that serves `queueHandler()` for Vercel's World.
//   - Schedules fire on `tick`, once per minute and occurrence across every process: `serve`
//     ticks each minute, and on Vercel a cron route calls it.

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
    readonly outcome: DriveOutcome;
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
  /**
   * Handles one queue delivery: runs the session it wakes until it waits, or hands off near the
   * deadline (`{ timeoutSeconds: 0 }`, which the World reads as "deliver again now").
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
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The run that claims one occurrence of a schedule: a ULID with the occurrence's minute as its
 * time and the schedule's name hashed as the rest, so every process ticking that minute names the
 * same run, and only the first creates it. (A World refuses run ids from more than a day ago, so
 * a run per occurrence, not one ledger.)
 */
function occurrenceRunId(name: string, minuteMs: number): string {
  let time = "";
  for (let rest = minuteMs, index = 0; index < 10; index += 1) {
    time = CROCKFORD[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  // 80 bits of FNV-1a over the name, five bits at a time.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(name))
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & ((1n << 80n) - 1n);
  let random = "";
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[Number(hash & 31n)]! + random;
    hash >>= 5n;
  }
  return `wrun_${time}${random}`;
}

export function createWorldHost(options: WorldHostOptions): WorldHost {
  const { world } = options;
  const budgetMs = options.deliveryBudgetMs ?? 4 * 60_000;
  const agents = new Map<string, CodeAgent>();
  for (const defined of options.agents) {
    const agent = codeAgentOf(defined);
    if (agents.has(agent.id)) throw new Error(`Two agents of this host are named "${agent.id}".`);
    agents.set(agent.id, agent);
  }
  const fronts = new Map<string, Runtime>();
  const runtime = (agent: string): Runtime => {
    if (!agents.has(agent)) throw new Error(`This host has no agent "${agent}".`);
    let front = fronts.get(agent);
    if (front === undefined) fronts.set(agent, (front = createFrontRuntime({ agent, world })));
    return front;
  };
  const releaseLines = registerFallbackLineStore(worldLineStore(world));
  let ticker: ReturnType<typeof setTimeout> | undefined;

  const deliver: WorldHost["deliver"] = async (message, delivery) => {
    const sessionId = sessionOfWake(message);
    if (sessionId === undefined) return undefined;
    const startedAt = delivery.invocationStartedAt ?? Date.now();
    const outcome = await driveSession({
      agent(name) {
        const agent = agents.get(name);
        return agent === undefined
          ? undefined
          : { config: { agent }, release: holdSessionAgent(agent) };
      },
      deadline: startedAt + budgetMs,
      sessionId,
      world,
    });
    options.observe?.({ ms: Date.now() - startedAt, outcome, sessionId });
    return outcome.kind === "handoff" ? { timeoutSeconds: 0 } : undefined;
  };

  /** Whether this process is the first to fire `name`'s occurrence in the minute at `minuteMs`. */
  const claimOccurrence = async (name: string, minuteMs: number): Promise<boolean> => {
    try {
      await world.events.create(occurrenceRunId(name, minuteMs), {
        eventData: {
          deploymentId: await world.getDeploymentId(),
          input: new TextEncoder().encode(
            JSON.stringify({ at: new Date(minuteMs).toISOString(), name }),
          ),
          workflowName: "eve/world-host-schedule",
        },
        eventType: "run_created",
      });
      return true;
    } catch (error) {
      if (isEntityConflict(error)) return false;
      throw error;
    }
  };

  const tick: WorldHost["tick"] = async (at = new Date()) => {
    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    const fired: string[] = [];
    for (const [name, { agent, schedule }] of Object.entries(options.schedules ?? {})) {
      if (!cronFiresAt(schedule.cron, at) || !(await claimOccurrence(name, minute))) continue;
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
    runtime,
    deliver,
    tick,
    queueHandler: () => world.createQueueHandler(WORLD_HOST_QUEUE_PREFIX, deliver),
    session: (agent, sessionOptions) => worldSession(runtime(agent), world, sessionOptions),
    async serve() {
      world.registerHandler?.(
        WORLD_HOST_QUEUE_PREFIX,
        world.createQueueHandler(WORLD_HOST_QUEUE_PREFIX, deliver),
      );
      await world.start?.();
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

function worldSession(
  runtime: Runtime,
  world: QueueWorld,
  options: { readonly identity: SessionAuthContext | null; readonly resume?: string },
): WorldSession {
  const auth = options.identity;
  let sessionId = options.resume;
  const ready = (async () => {
    // A resumed session's address is the one it started with.
    const recorded =
      options.resume === undefined
        ? undefined
        : (await readSessionLog(world, options.resume)).start?.input.continuationToken;
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
