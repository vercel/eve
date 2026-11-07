import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import { codeAgentOf } from "#embed/agent.js";
import type { ActivationOutcome } from "#execution/entity/entities.js";
import {
  installDurableHost,
  installedDurableHost,
  uninstallDurableHost,
  type DurableHost,
} from "#execution/hosts.js";
import type { QueueWorld, WorldQueueDelivery } from "#execution/world/runtime-world.js";
import { createLogger, logError } from "#internal/logging.js";
import type { DefinedAgent } from "#public/definitions/agent.js";
import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { holdSessionAgent, type CodeAgent } from "#runtime/sessions/session-agent.js";
import { handleCallback } from "#compiled/@vercel/queue/index.js";
import { createScheduleOccurrenceConsumer } from "#internal/schedules/occurrence-consumer.js";
import { compiledAgentChannels, worldHostChannels } from "./channels.js";
import { cronFiresAt } from "./cron.js";
import { worldDurableHost } from "./durable-host.js";
import { fireDueSchedules } from "./dynamic-schedules.js";
import { registerWorldScheduleStore, worldScheduleStore } from "./schedule-store.js";
import { sessionActivation } from "./driver.js";
import { prepareInitialEntry } from "#execution/initial-entry.js";
import { createWorldFront, type WorldFront } from "./world-front.js";

export type {
  WorldFront,
  WorldFrontAgent,
  WorldFrontOptions,
  WorldHostSession,
} from "./world-front.js";

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
 * A World host: the front its callers reach sessions through (`world-front.ts`: `runtime`,
 * `createSession`, `eveChannel`), and the process that runs them when their wakes arrive.
 */
export interface WorldHost extends WorldFront {
  /**
   * The consumer route of the Vercel Schedules occurrences of the agent compiled from files named
   * `agent`: serve it at `/.well-known/eve/v1/schedules/consumer`, a queue trigger of the agent's
   * schedule topic. Occurrences start sessions on this host.
   */
  scheduleConsumer(agent: string): (request: Request) => Promise<Response>;
  /**
   * A `fetch` serving the channels of the agent compiled from files named `agent`: its own, and
   * the framework's (eve's channel, the sign-in callback). Serve it at the server's root. An agent
   * defined in code has eve's channel through `eveChannel`.
   */
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
  const front = createWorldFront(
    { world, agents: [...agents.keys()], queueNamespace: options.queueNamespace },
    {
      // A session this host doesn't hold (one a Workflow run opened, as a workflow tool's
      // `ctx.agent` does) is read where it lives: Workflow's, when this host wraps it.
      ...(options.workflow !== undefined && { fallbackLineStore: options.workflow.host.lineStore }),
      // As the session's start will decide it: its agent's retention, or its trace capture.
      async purgesOnEnd(agent, input) {
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
    },
  );
  const { entities, runtime } = front;
  const activation = entities.activation!;
  const { lineStore } = front;
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
    ...front,
    deliver: consumer.deliver,
    tick,
    queueHandler: () => consumer.route(),
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
        channels: compiledAgentChannels(hosted.compiled),
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
      await front.close();
      uninstallDurableHost(durable);
      releaseSchedules();
    },
  };
}
