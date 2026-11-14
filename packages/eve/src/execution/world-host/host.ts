import type { Runtime } from "#channel/types.js";
import type { ActivationOutcome, Actors } from "#execution/actor/actors.js";
import { registerFallbackLineStore, registerHost } from "#execution/hosts.js";
import { inProcessRunOwner, type WorkflowFunction } from "#execution/in-process/runs.js";
import type { InProcessRuntimeOptions } from "#execution/in-process/runtime.js";
import { rootOfChild } from "#execution/in-process/world-store.js";
import {
  logicalSessionInboxToken,
  sessionIdOfCommandToken,
} from "#execution/session-inbox/address.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { QueueWorld, WorldQueueDelivery } from "#execution/world/runtime-world.js";
import { sessionActors } from "#execution/world/session-actors.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { sessionActivation, type SessionMessage } from "./driver.js";
import { createFrontRuntime, type FrontRuntime } from "./front.js";

// A World host: compiled agents whose sessions run only when something arrives for them. Each
// session is a durable actor (`#execution/actor`): its actor keeps it, a message or its alarm
// activates it, and whichever process the activation reaches runs it until it waits again
// (`driver.ts`). No process holds a session between activations, so a session waits a day on an
// approval, or on a timer, at no cost.
//   - Anything that talks to a session (a script, an HTTP route, a channel) goes through the
//     host's runtime for its agent, which creates actors and sends to them (`front.ts`).
//   - What's delivered in this process to an address no running session holds (a hook token, a
//     session's inbox, a run's hook) goes to the actor that has it: the host is a route that
//     sends a payload to the mailbox of the actor owning its address (`registerHost`).
//   - A session's stream is its actor's, read from the World by anyone (`registerFallbackLineStore`).
//   - Activations are consumed where the World's queue delivers them: in this process for a
//     local, Postgres or memory World (`serve`), or at a route that serves `queueHandler()` for
//     Vercel's.

/** How long a delivery runs a session by default: below a serverless function's limit. */
const DEFAULT_DELIVERY_BUDGET_MS = 4 * 60_000;

export interface WorldHostOptions {
  /** The World that keeps the sessions and delivers their activations. */
  readonly world: QueueWorld;
  /** The agents its sessions run, by the name each is known by here: their compiled artifacts. */
  readonly agents: Readonly<Record<string, RuntimeCompiledArtifactsSource>>;
  /**
   * How long one delivery may run a session before it hands off to the next, in milliseconds:
   * what the runtime serving `queueHandler()` allows a request, less a margin. Default 4 minutes.
   */
  readonly deliveryBudgetMs?: number;
  /**
   * Where the server routes eve's callbacks (`/.well-known/eve/...`), which sign-in links name.
   * Without one, a tool that needs a sign-in can't ask.
   */
  readonly callbackBaseUrl?: string;
  /** Starts a run of a workflow tool whose body this host doesn't hold (Workflow's). */
  readonly startDurableRun?: StartWorkflowToolRun;
  /** The queue namespace its activations travel in; a default shared by World hosts otherwise. */
  readonly queueNamespace?: string;
  /** What else each activation's in-process runtime is made with (a test's step boundary, say). */
  readonly runtimeOptions?: Omit<
    InProcessRuntimeOptions,
    "world" | "worldStore" | "servesLines" | "runOwner" | "callbackBaseUrl"
  >;
  /** Told how each delivery that ran a session ended, and how long it ran. */
  readonly observe?: (delivery: {
    readonly sessionId: string;
    readonly outcome: ActivationOutcome;
    readonly ms: number;
  }) => void;
}

export interface WorldHost {
  readonly world: QueueWorld;
  /** The sessions, as the actors they are on the World. */
  readonly actors: Actors;
  /** The runtime sessions of `agent` are reached through: it runs nothing itself. */
  runtime(agent: string): FrontRuntime;
  /** Makes an authored workflow tool's plain body run in this host's activations. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /**
   * Handles one queue delivery: runs the session it activates until it waits, or continues it
   * in the next delivery near the deadline.
   */
  deliver(message: unknown, delivery: WorldQueueDelivery): Promise<unknown>;
  /** The route handler of a World that delivers activations over HTTP, such as Vercel's. */
  queueHandler(): (request: Request) => Promise<Response>;
  /** Consumes activations in this process (a local, Postgres or memory World). */
  serve(): Promise<void>;
  close(): Promise<void>;
}

export function createWorldHost(options: WorldHostOptions): WorldHost {
  const { world } = options;
  const agents = new Map(Object.entries(options.agents));
  const workflows = new Map<string, WorkflowFunction>();
  const actors = sessionActors(world, options.queueNamespace);
  const activation = actors.activation;
  if (activation === undefined) throw new Error("A World host needs a World with a queue.");
  const fronts = new Map<string, FrontRuntime>();
  const runtime = (agent: string): FrontRuntime => {
    if (!agents.has(agent)) throw new Error(`This host has no agent "${agent}".`);
    let front = fronts.get(agent);
    if (front === undefined) fronts.set(agent, (front = createFrontRuntime({ actors, agent })));
    return front;
  };

  // Its sessions are actors of the session kind, keyed `session_…`; anything else isn't its.
  const releaseLines = registerFallbackLineStore(actorLineStore(actors), (sessionId) =>
    sessionId.startsWith("session_"),
  );
  // What's delivered here to an address no running session holds goes to the actor that has it.
  // Routes that run sessions (an activation's) answer first for what they hold.
  const releaseRoute = registerHost({
    async deliver(token, payload) {
      const alias = logicalSessionInboxToken(token) ?? token;
      const sent = await actors.send({ alias }, { deliver: payload } satisfies SessionMessage);
      if (sent !== undefined) return "delivered";
      // A hook of a run an activation ran, which may have stopped since, or of a session another
      // session's activation runs (a subagent's): the actor whose activation runs it.
      const child = sessionIdOfCommandToken(alias);
      const owner =
        inProcessRunOwner(token) ??
        (child === undefined
          ? undefined
          : rootOfChild(await actors.meta(child).catch(() => undefined)));
      if (owner === undefined) return undefined;
      const reached = await actors.send({ key: owner }, {
        deliver: payload,
        token,
      } satisfies SessionMessage);
      return reached === undefined ? undefined : "delivered";
    },
    runEnded: () => undefined,
    cancelRun: () => undefined,
  });

  const consumer = activation.consumer(
    sessionActivation({
      actors,
      agent: (name) => {
        const source = agents.get(name);
        return source === undefined ? undefined : { compiledArtifactsSource: source };
      },
      runtime: (name) => runtime(name) as Runtime,
      workflows: () => workflows,
      world,
      ...(options.callbackBaseUrl !== undefined && { callbackBaseUrl: options.callbackBaseUrl }),
      ...(options.startDurableRun !== undefined && { startDurableRun: options.startDurableRun }),
      ...(options.runtimeOptions !== undefined && { runtimeOptions: options.runtimeOptions }),
    }),
    {
      budgetMs: options.deliveryBudgetMs ?? DEFAULT_DELIVERY_BUDGET_MS,
      ...(options.observe !== undefined && {
        observe: ({ key, ms, outcome }) => options.observe!({ ms, outcome, sessionId: key }),
      }),
    },
  );

  return {
    world,
    actors,
    runtime,
    registerWorkflow(workflowId, body) {
      workflows.set(workflowId, body);
    },
    deliver: consumer.deliver,
    queueHandler: () => consumer.route(),
    serve: () => consumer.serve(),
    async close() {
      releaseRoute();
      releaseLines();
    },
  };
}

/** A session's stream as its actor's, for readers in any process. */
function actorLineStore(actors: Actors): SessionLineStore {
  const assertPurgedUnread = async (sessionId: string) => {
    if (await actors.purged(sessionId))
      throw new RunExpiredError("Session history is no longer available.", sessionId, "completed");
  };
  return {
    assertReadable: assertPurgedUnread,
    readable: (sessionId, startIndex) => actors.read(sessionId, startIndex),
    async tail(sessionId) {
      await assertPurgedUnread(sessionId);
      return (await actors.streamLength(sessionId)) - 1;
    },
  };
}
