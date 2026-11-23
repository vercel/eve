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
import { processApp } from "#runtime/app.js";
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

export interface ProcessEngine {
  readonly name: string;
  readonly durable: Durable;
  readonly resume: ResumeAddress;
  deploymentId(): Promise<string>;
  runStatus(runId: string): Promise<string>;
  cancelRun(runId: string, reason: string): Promise<void>;
  readonly sessionEvents: SessionEventStore;
  stepAttempt(): number | undefined;
  callbackBaseUrl(): string | undefined;
}

export interface Hosts {
  readonly routes: Set<HostedRoute>;
  readonly sessionEventStores: Map<string, SessionEventStore>;
  engine?: ProcessEngine;
}

function hosts(): Hosts {
  return processApp().hosts;
}

export function registerHost(route: HostedRoute): () => void {
  hosts().routes.add(route);
  return () => {
    hosts().routes.delete(route);
  };
}

export function installProcessEngine(engine: ProcessEngine): ProcessEngine {
  const state = hosts();
  state.engine ??= engine;
  if (state.engine.name !== engine.name)
    throw new Error(
      `This realm's durable engine is "${state.engine.name}"; "${engine.name}" can't replace it.`,
    );
  return state.engine;
}

export function installedProcessEngine(): ProcessEngine | undefined {
  return hosts().engine;
}

function engineFor(id: string): ProcessEngine {
  const { engine } = hosts();
  if (engine === undefined) throw new HookNotFoundError(id);
  return engine;
}

export function installedDurable(): Durable | undefined {
  return hosts().engine?.durable;
}

export function sessionSignInCallbacks(sessionId: string): SignInCallbacks | undefined {
  for (const route of hosts().routes) {
    const callbacks = route.signInCallbacks?.(sessionId);
    if (callbacks !== undefined) return callbacks;
  }
  const { engine } = hosts();
  const callbackBaseUrl = engine?.callbackBaseUrl();
  return engine === undefined || callbackBaseUrl === undefined
    ? undefined
    : { callbackBaseUrl, deliver: engine.resume };
}

export function isRetriedStep(): boolean {
  return (stepAttempt() ?? 1) > 1;
}

function stepAttempt(): number | undefined {
  for (const route of hosts().routes) {
    const attempt = route.stepAttempt?.();
    if (attempt !== undefined) return attempt;
  }
  return hosts().engine?.stepAttempt();
}

export async function deliverToHostedHook(token: string, payload: unknown): Promise<boolean> {
  for (const route of hosts().routes) {
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

export async function resumeRoutedHook(token: string, payload: unknown): Promise<void> {
  if (!(await deliverToHostedHook(token, payload)))
    await engineFor(token).resume(hookAddress(token), payload);
}

export async function resumeRoutedSessionInbox(
  address: string | SessionInboxAddress,
  delivery: DeliverHookPayload,
): Promise<void> {
  const token = sessionInboxHookToken(logicalSessionToken(address));
  if (!(await deliverToHostedHook(token, delivery)))
    await engineFor(token).resume(sessionAddress(address), delivery);
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

export async function routedRunEnded(runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(runId);
  if (hosted !== undefined) return hosted;
  const { engine } = hosts();
  return engine === undefined ? true : await durableRunEnded(engine.runStatus, runId);
}

export async function durableRunEnded(
  runStatus: ProcessEngine["runStatus"],
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

export async function routedRunLive(runId: string): Promise<boolean> {
  const hosted = hostedRunEnded(runId);
  if (hosted !== undefined) return !hosted;
  try {
    return isRunning(await engineFor(runId).runStatus(runId));
  } catch (error) {
    return !isRunTargetGone(error);
  }
}

export async function cancelRoutedRun(runId: string, reason: string): Promise<boolean> {
  for (const route of hosts().routes) {
    const cancelled = route.cancelRun(runId, reason);
    if (cancelled !== undefined) return cancelled;
  }
  await engineFor(runId).cancelRun(runId, reason);
  return true;
}

export function registerSessionEventStore(sessionId: string, store: SessionEventStore): () => void {
  const { sessionEventStores } = hosts();
  if (sessionEventStores.has(sessionId))
    throw new Error(`Session "${sessionId}" already has a session event store.`);
  sessionEventStores.set(sessionId, store);
  return () => {
    if (sessionEventStores.get(sessionId) === store) sessionEventStores.delete(sessionId);
  };
}

export function sessionEventStore(sessionId: string): SessionEventStore {
  const registered = hosts().sessionEventStores.get(sessionId);
  if (registered !== undefined) return registered;
  const { engine } = hosts();
  if (engine === undefined) throw new Error(`No host in this realm holds session "${sessionId}".`);
  return engine.sessionEvents;
}
