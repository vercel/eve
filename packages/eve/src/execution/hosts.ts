import type { DeliverHookPayload } from "#channel/types.js";
import {
  logicalSessionToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { CreateRuntime } from "#execution/node-step.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import type { ConnectionEventOwners } from "#runtime/connections/events/owners.js";
import {
  HookNotFoundError,
  isRunNotFound,
  isRunTargetGone,
  RunNotFoundError,
} from "#shared/run-errors.js";

// The hosts in this realm, for code that addresses a hook, a run or a session stream by id, or
// asks whether the durable step it runs in is a retry, and runs on any host.
//
// A host that keeps sessions and runs in this process (the in-process host) registers a route for
// the hooks and runs it holds, and each session stream it keeps. A durable host whose state lives
// elsewhere (Workflow) is installed: it answers for every id no route holds, and names the attempt
// of the step running now. Workflow installs itself with the code that runs on it (its builtin
// steps, which every Workflow step bundle registers, and `createWorkflowRuntime`), so a realm that
// never loads Workflow never reaches it, and one that runs Workflow's steps can't miss it. Without
// an installed host, an id no route holds is gone, and no step is a retry.

/** What one host in this realm holds. Each answer is `undefined` for an id it never held. */
export interface HostedRoute {
  /**
   * Delivers `payload` to the hook `token` names: `delivered`, or `gone` for one it held once.
   * Async, so the holder can keep the payload, and it can cross the host's step boundary.
   */
  deliver(token: string, payload: unknown): Promise<"delivered" | "gone" | undefined>;
  /** Whether `runId` ended. */
  runEnded(runId: string): boolean | undefined;
  /** Stops `runId` outright: `true` when it was running here. */
  cancelRun(runId: string, reason: string): boolean | undefined;
}

/** The realm's durable host: what no route holds is its, and its steps can be retried. */
/** What a session's run records of it (`DurableHost.sessionRecord`). */
export interface SessionRunRecord {
  /** The session's id, as its invocation names it. */
  readonly runId: string;
  /** As a Workflow run's: `"running"`, or `"completed"`, `"failed"` or `"cancelled"` once it ended. */
  readonly status: string;
  readonly createdAt: Date;
  readonly expiredAt?: Date;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface DurableHost {
  /** Names the host: each module copy that installs it builds an equal one. */
  readonly name: string;
  /**
   * The host this one goes on to for what it doesn't hold, by name: installing this one replaces
   * that one, and installing that one after it changes nothing. A World host's wraps Workflow's,
   * in a build whose authored workflow tools run on Workflow.
   */
  readonly wraps?: string;
  /** Throws a hook-not-found error for a hook that doesn't exist. */
  resumeHook(token: string, payload: unknown): Promise<void>;
  /** Delivers through the session's inbox protocol, which waits out a handoff. */
  resumeSessionInbox(
    address: string | SessionInboxAddress,
    delivery: DeliverHookPayload,
  ): Promise<void>;
  /** The run's status: `pending` and `running` haven't ended. Throws for a run it can't read. */
  runStatus(runId: string): Promise<string>;
  cancelRun(runId: string, reason: string): Promise<void>;
  /** Where the sessions it runs keep their streams. */
  readonly lineStore: SessionLineStore;
  /**
   * What a session's run records of it, where its host keeps that other than as a Workflow run:
   * when it started, when it expires, and its attributes (an external invocation's owner and
   * token). `undefined` for a session it doesn't hold. Without it, Workflow's run is read.
   */
  sessionRecord?(sessionId: string): Promise<SessionRunRecord | undefined>;
  /** The attempt of the durable step running now: 1 for its first, more for a retry. */
  stepAttempt(): number | undefined;
  /** A runtime whose sessions run on this host: what a schedule's occurrence starts in. */
  readonly createRuntime: CreateRuntime;
  /** Keeps connection event subscriptions: each watch's owner, found and retired by binding id. */
  readonly connectionEvents: ConnectionEventOwners;
}

interface Hosts {
  readonly routes: Set<HostedRoute>;
  readonly streams: Map<string, SessionLineStore>;
  /** Where a session no store here holds is read from: a World host's World. */
  fallbackStreams?: SessionLineStore;
  durable?: DurableHost;
}

// Process-wide, as the context storage is: Workflow's local world and step bundles load their
// own copies of eve's modules, and every copy must see the same hosts.
const HOSTS = Symbol.for("eve.hosts");

function hosts(): Hosts {
  const holder = globalThis as { [HOSTS]?: Hosts };
  return (holder[HOSTS] ??= { routes: new Set(), streams: new Map() });
}

/** Routes the hooks and runs `route` holds to it until the returned release. */
export function registerHost(route: HostedRoute): () => void {
  hosts().routes.add(route);
  return () => {
    hosts().routes.delete(route);
  };
}

/**
 * Makes `host` this realm's durable host. Installing it again, from this copy of eve's modules or
 * another, keeps the first; a different host is refused, so two durable hosts never share a realm.
 */
export function installDurableHost(host: DurableHost): void {
  const state = hosts();
  if (state.durable === undefined || host.wraps === state.durable.name) state.durable = host;
  else if (state.durable.name !== host.name && state.durable.wraps !== host.name)
    throw new Error(
      `This realm's durable host is "${state.durable.name}"; "${host.name}" can't replace it.`,
    );
}

/** Gives up `host` as this realm's durable host, if it is: a World host that closed. */
export function uninstallDurableHost(host: DurableHost): void {
  const state = hosts();
  if (state.durable === host) state.durable = undefined;
}

/** The durable host, for a hook token or run id no route holds; without one, it's gone. */
function durableHostFor(target: { readonly hook: string } | { readonly run: string }): DurableHost {
  const { durable } = hosts();
  if (durable !== undefined) return durable;
  throw "hook" in target ? new HookNotFoundError(target.hook) : new RunNotFoundError(target.run);
}

/**
 * The realm's durable host, for what only a durable host keeps (scheduled runs, connection event
 * watches) wherever it's asked: in a turn, a tool's own step, or a route. `undefined` in a realm
 * with none, such as a process that runs sessions only in-process.
 */
export function installedDurableHost(): DurableHost | undefined {
  return hosts().durable;
}

/** Whether the step running now is a retry of an attempt that may have written already. */
export function isRetriedStep(): boolean {
  return (hosts().durable?.stepAttempt() ?? 1) > 1;
}

/**
 * Delivers `payload` to the hook `token` names when a route here holds it: `true` once delivered,
 * `false` when none ever held it. Throws `HookNotFoundError` for a token a route held once.
 */
export async function deliverToHostedHook(token: string, payload: unknown): Promise<boolean> {
  for (const route of hosts().routes) {
    const delivered = await route.deliver(token, payload);
    if (delivered === "delivered") return true;
    if (delivered === "gone") throw new HookNotFoundError(token);
  }
  return false;
}

/** Resumes the hook `token` names, wherever it's held. */
export async function resumeRoutedHook(token: string, payload: unknown): Promise<void> {
  if (!(await deliverToHostedHook(token, payload)))
    await durableHostFor({ hook: token }).resumeHook(token, payload);
}

/** Delivers `delivery` to the session `address` names, wherever it runs. */
export async function resumeRoutedSessionInbox(
  address: string | SessionInboxAddress,
  delivery: DeliverHookPayload,
): Promise<void> {
  const token = sessionInboxHookToken(logicalSessionToken(address));
  if (!(await deliverToHostedHook(token, delivery)))
    await durableHostFor({ hook: token }).resumeSessionInbox(address, delivery);
}

function hostedRunEnded(runId: string): boolean | undefined {
  for (const route of hosts().routes) {
    const ended = route.runEnded(runId);
    if (ended !== undefined) return ended;
  }
  return undefined;
}

function isRunning(status: string): boolean {
  return status === "pending" || status === "running";
}

/**
 * Whether `runId` was accepted and has finished, wherever it runs. A durable run one `start()`
 * accepted may not be readable yet, so one not found hasn't ended; one whose target is gone has,
 * as has one no route holds in a realm with no durable host to run it.
 */
export async function routedRunEnded(runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(runId);
  if (hosted !== undefined) return hosted;
  const { durable } = hosts();
  return durable === undefined ? true : await durableRunEnded(durable, runId);
}

/** Whether the durable host's run `runId` has finished, as {@link routedRunEnded} reads it. */
export async function durableRunEnded(host: DurableHost, runId: string): Promise<boolean> {
  try {
    return !isRunning(await host.runStatus(runId));
  } catch (error) {
    if (isRunNotFound(error)) return false;
    if (isRunTargetGone(error)) return true;
    throw error;
  }
}

/** Whether `runId` still runs, wherever it runs; one whose status can't be read counts as live. */
export async function routedRunLive(runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(runId);
  if (hosted !== undefined) return !hosted;
  try {
    return isRunning(await durableHostFor({ run: runId }).runStatus(runId));
  } catch (error) {
    return !isRunTargetGone(error);
  }
}

/** Cancels `runId` outright, wherever it runs. */
export async function cancelRoutedRun(runId: string, reason: string): Promise<void> {
  for (const route of hosts().routes) if (route.cancelRun(runId, reason) !== undefined) return;
  await durableHostFor({ run: runId }).cancelRun(runId, reason);
}

/**
 * Keeps `sessionId`'s stream in `store`, for every reader in this realm, until the returned
 * release. A session has one store: a second is refused.
 */
export function registerSessionLineStore(sessionId: string, store: SessionLineStore): () => void {
  const { streams } = hosts();
  if (streams.has(sessionId)) throw new Error(`Session "${sessionId}" already has a line store.`);
  streams.set(sessionId, store);
  return () => {
    if (streams.get(sessionId) === store) streams.delete(sessionId);
  };
}

/**
 * Reads the stream of any session no store is registered for from `store`, until the returned
 * release: a World host's, whose sessions run in whichever process a wake reached.
 */
export function registerFallbackLineStore(store: SessionLineStore): () => void {
  const held = hosts();
  if (held.fallbackStreams !== undefined)
    throw new Error("This realm reads sessions from a World already.");
  held.fallbackStreams = store;
  return () => {
    if (held.fallbackStreams === store) held.fallbackStreams = undefined;
  };
}

/**
 * The store that holds `sessionId`'s stream: a registered one, a World host's, or the durable
 * host's.
 */
export function sessionLineStore(sessionId: string): SessionLineStore {
  const registered = hosts().streams.get(sessionId);
  if (registered !== undefined) return registered;
  const fallback = hosts().fallbackStreams;
  if (fallback !== undefined) return fallback;
  const { durable } = hosts();
  if (durable === undefined) throw new Error(`No host in this realm holds session "${sessionId}".`);
  return durable.lineStore;
}
