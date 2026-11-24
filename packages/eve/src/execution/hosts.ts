import type { DeliverHookPayload } from "#channel/types.js";
import {
  hookAddress,
  sessionAddress,
  signInAddress,
  type DeliveryAddress,
  type Durable,
} from "#execution/durable.js";
import {
  logicalSessionToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { registerCleanup, type Lifetime } from "#runtime/lifetime.js";
import { HookNotFoundError, isRunNotFound, isRunTargetGone } from "#shared/run-errors.js";

export interface HostedRoute {
  deliver(token: string, payload: unknown): Promise<"delivered" | "gone" | undefined>;
  runEnded(runId: string): boolean | undefined;
  cancelRun(runId: string, reason: string): boolean | undefined;
  stepAttempt?(): number | undefined;
  signInCallbacks?(sessionId: string): SignInCallbacks | undefined;
}

export type ResumeAddress = (to: DeliveryAddress, payload: unknown) => Promise<void>;

export interface SignInCallbacks {
  readonly callbackBaseUrl: string;
  readonly deliver: ResumeAddress;
}

export interface EngineRoutes {
  readonly resume: ResumeAddress;
  runStatus(runId: string): Promise<string>;
  cancelRun(runId: string, reason: string): Promise<void>;
  stepAttempt(): number | undefined;
  callbackBaseUrl(): string | undefined;
}

export interface HookRoutes {
  readonly hosted: Set<HostedRoute>;
  engine?: EngineRoutes;
}

export interface SessionStreams {
  readonly bySession: Map<string, SessionEventStore>;
  engine?: SessionEventStore;
}

export interface AppHosts {
  readonly routes: HookRoutes;
  readonly streams: SessionStreams;
}

export type RouteHosts = Pick<AppHosts, "routes">;
export type StreamHosts = Pick<AppHosts, "streams">;

export interface ProcessEngine extends EngineRoutes {
  readonly name: string;
  readonly durable: Durable;
  readonly sessionEvents: SessionEventStore;
  deploymentId(): Promise<string>;
}

export interface ProcessHosts extends AppHosts {
  engine?: ProcessEngine;
}

export function createProcessHosts(): ProcessHosts {
  return { routes: { hosted: new Set() }, streams: { bySession: new Map() } };
}

export interface EngineHosting {
  route(route: HostedRoute): void;
  session(sessionId: string, events: SessionEventStore): void;
}

export function hostEngine(app: {
  readonly hosts: AppHosts;
  readonly lifetime: Lifetime;
}): EngineHosting {
  return {
    route: (route) => registerCleanup(app.lifetime, registerHostedRoute(app.hosts, route)),
    session: (sessionId, events) =>
      registerCleanup(app.lifetime, registerSessionEventStore(app.hosts, sessionId, events)),
  };
}

export function registerHostedRoute({ routes }: RouteHosts, route: HostedRoute): () => void {
  routes.hosted.add(route);
  return () => {
    routes.hosted.delete(route);
  };
}

export function installProcessEngine(hosts: ProcessHosts, engine: ProcessEngine): ProcessEngine {
  hosts.engine ??= engine;
  if (hosts.engine.name !== engine.name)
    throw new Error(
      `This realm's durable engine is "${hosts.engine.name}"; "${engine.name}" can't replace it.`,
    );
  hosts.routes.engine = hosts.engine;
  hosts.streams.engine = hosts.engine.sessionEvents;
  return hosts.engine;
}

export function replaceProcessEngine(hosts: ProcessHosts, engine: ProcessEngine): ProcessEngine {
  if (hosts.engine?.name === engine.name) hosts.engine = engine;
  return installProcessEngine(hosts, engine);
}

export function installedProcessEngine(hosts: ProcessHosts): ProcessEngine | undefined {
  return hosts.engine;
}

function engineFor({ routes }: RouteHosts, id: string): EngineRoutes {
  const { engine } = routes;
  if (engine === undefined) throw new HookNotFoundError(id);
  return engine;
}

export function installedDurable(hosts: ProcessHosts): Durable | undefined {
  return hosts.engine?.durable;
}

export function sessionSignInCallbacks(
  { routes }: RouteHosts,
  sessionId: string,
): SignInCallbacks | undefined {
  for (const route of routes.hosted) {
    const callbacks = route.signInCallbacks?.(sessionId);
    if (callbacks !== undefined) return callbacks;
  }
  const { engine } = routes;
  const callbackBaseUrl = engine?.callbackBaseUrl();
  return engine === undefined || callbackBaseUrl === undefined
    ? undefined
    : { callbackBaseUrl, deliver: engine.resume };
}

export function isRetriedStep(meta: { readonly attempt: number }): boolean {
  return meta.attempt > 1;
}

export function stepAttempt({ routes }: RouteHosts): number | undefined {
  for (const route of routes.hosted) {
    const attempt = route.stepAttempt?.();
    if (attempt !== undefined) return attempt;
  }
  return routes.engine?.stepAttempt();
}

export async function deliverToHostedHook(
  { routes }: RouteHosts,
  token: string,
  payload: unknown,
): Promise<boolean> {
  for (const route of routes.hosted) {
    const delivered = await route.deliver(token, payload);
    if (delivered === "delivered") return true;
    if (delivered === "gone") throw new HookNotFoundError(token);
  }
  return false;
}

export function signInDelivery(
  deliver: ResumeAddress,
): (token: string, payload: AuthorizationCallbackPayload) => Promise<void> {
  return (token, payload) => deliver(signInAddress(token), payload);
}

export async function resumeRoutedHook(
  hosts: RouteHosts,
  token: string,
  payload: unknown,
): Promise<void> {
  if (!(await deliverToHostedHook(hosts, token, payload)))
    await engineFor(hosts, token).resume(hookAddress(token), payload);
}

export async function resumeRoutedSessionInbox(
  hosts: RouteHosts,
  address: string | SessionInboxAddress,
  delivery: DeliverHookPayload,
): Promise<void> {
  const token = sessionInboxHookToken(logicalSessionToken(address));
  if (!(await deliverToHostedHook(hosts, token, delivery)))
    await engineFor(hosts, token).resume(sessionAddress(address), delivery);
}

function hostedRunEnded({ routes }: RouteHosts, runId: string): boolean | undefined {
  for (const route of routes.hosted) {
    const ended = route.runEnded(runId);
    if (ended !== undefined) return ended;
  }
  return undefined;
}

function isRunning(status: string): boolean {
  return status === "pending" || status === "running";
}

export async function routedRunEnded(hosts: RouteHosts, runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(hosts, runId);
  if (hosted !== undefined) return hosted;
  const { engine } = hosts.routes;
  return engine === undefined ? true : await durableRunEnded(engine.runStatus, runId);
}

export async function durableRunEnded(
  runStatus: EngineRoutes["runStatus"],
  runId: string,
): Promise<boolean> {
  try {
    return !isRunning(await runStatus(runId));
  } catch (error) {
    if (isRunNotFound(error)) return false;
    if (isRunTargetGone(error)) return true;
    throw error;
  }
}

export async function routedRunLive(hosts: RouteHosts, runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(hosts, runId);
  if (hosted !== undefined) return !hosted;
  try {
    return isRunning(await engineFor(hosts, runId).runStatus(runId));
  } catch (error) {
    return !isRunTargetGone(error);
  }
}

export async function cancelRoutedRun(
  hosts: RouteHosts,
  runId: string,
  reason: string,
): Promise<boolean> {
  for (const route of hosts.routes.hosted) {
    const cancelled = route.cancelRun(runId, reason);
    if (cancelled !== undefined) return cancelled;
  }
  await engineFor(hosts, runId).cancelRun(runId, reason);
  return true;
}

export function registerSessionEventStore(
  { streams }: StreamHosts,
  sessionId: string,
  store: SessionEventStore,
): () => void {
  const { bySession } = streams;
  if (bySession.has(sessionId))
    throw new Error(`Session "${sessionId}" already has a session event store.`);
  bySession.set(sessionId, store);
  return () => {
    if (bySession.get(sessionId) === store) bySession.delete(sessionId);
  };
}

export function sessionEventStore({ streams }: StreamHosts, sessionId: string): SessionEventStore {
  const registered = streams.bySession.get(sessionId);
  if (registered !== undefined) return registered;
  if (streams.engine === undefined)
    throw new Error(`No host in this realm holds session "${sessionId}".`);
  return streams.engine;
}
