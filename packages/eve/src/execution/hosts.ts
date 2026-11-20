import type { DeliverHookPayload } from "#channel/types.js";
import {
  logicalSessionToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { CreateRuntime } from "#execution/node-step.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import type { ConnectionEventOwners } from "#runtime/connections/events/owners.js";
import { eveRuntime } from "#runtime/eve-runtime.js";
import { HookNotFoundError, isRunNotFound, isRunTargetGone } from "#shared/run-errors.js";

export interface HostedRoute {
  deliver(token: string, payload: unknown): Promise<"delivered" | "gone" | undefined>;
  runEnded(runId: string): boolean | undefined;
  cancelRun(runId: string, reason: string): boolean | undefined;
  stepAttempt?(): number | undefined;
  signInCallbacks?(sessionId: string): SignInCallbacks | undefined;
}

export interface SignInCallbacks {
  readonly callbackBaseUrl: string;
  readonly deliver: DurableHost["deliver"];
}

export type DeliveryAddress =
  | { readonly hook: string }
  | { readonly session: string | SessionInboxAddress }
  | { readonly signIn: string };

export interface DurableRun {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiredAt: Date | undefined;
  readonly attributes: Readonly<Record<string, string | undefined>>;
}

export interface DurableHost {
  readonly name: string;
  deliver(to: DeliveryAddress, payload: unknown): Promise<void>;
  deploymentId(): Promise<string>;
  findRun(runId: string): Promise<DurableRun | undefined>;
  runStatus(runId: string): Promise<string>;
  cancelRun(runId: string, reason: string): Promise<void>;
  readonly lineStore: SessionLineStore;
  stepAttempt(): number | undefined;
  callbackBaseUrl(): string | undefined;
  readonly createRuntime: CreateRuntime;
  readonly connectionEvents: ConnectionEventOwners;
}

export interface Hosts {
  readonly routes: Set<HostedRoute>;
  readonly streams: Map<string, SessionLineStore>;
  durable?: DurableHost;
}

function hosts(): Hosts {
  return eveRuntime().hosts;
}

export function registerHost(route: HostedRoute): () => void {
  hosts().routes.add(route);
  return () => {
    hosts().routes.delete(route);
  };
}

export function installDurableHost(host: DurableHost): void {
  const state = hosts();
  if (state.durable === undefined) state.durable = host;
  else if (state.durable.name !== host.name)
    throw new Error(
      `This realm's durable host is "${state.durable.name}"; "${host.name}" can't replace it.`,
    );
}

function durableHostFor(id: string): DurableHost {
  const { durable } = hosts();
  if (durable === undefined) throw new HookNotFoundError(id);
  return durable;
}

export function installedDurableHost(): DurableHost | undefined {
  return hosts().durable;
}

export function requireDurableHost(): DurableHost {
  const { durable } = hosts();
  if (durable !== undefined) return durable;
  throw new Error(
    "eve needs durable execution here, but no durable host is installed in this process. The Workflow runtime installs it when eve serves routes or runs workflow steps.",
  );
}

export function sessionSignInCallbacks(sessionId: string): SignInCallbacks | undefined {
  for (const route of hosts().routes) {
    const callbacks = route.signInCallbacks?.(sessionId);
    if (callbacks !== undefined) return callbacks;
  }
  const { durable } = hosts();
  const callbackBaseUrl = durable?.callbackBaseUrl();
  return durable === undefined || callbackBaseUrl === undefined
    ? undefined
    : { callbackBaseUrl, deliver: durable.deliver };
}

export function isRetriedStep(): boolean {
  return (stepAttempt() ?? 1) > 1;
}

function stepAttempt(): number | undefined {
  for (const route of hosts().routes) {
    const attempt = route.stepAttempt?.();
    if (attempt !== undefined) return attempt;
  }
  return hosts().durable?.stepAttempt();
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
  deliver: DurableHost["deliver"],
): (token: string, payload: AuthorizationCallbackPayload) => Promise<void> {
  return (token, payload) => deliver({ signIn: token }, payload);
}

export async function resumeRoutedHook(token: string, payload: unknown): Promise<void> {
  if (!(await deliverToHostedHook(token, payload)))
    await durableHostFor(token).deliver({ hook: token }, payload);
}

export async function resumeRoutedSessionInbox(
  address: string | SessionInboxAddress,
  delivery: DeliverHookPayload,
): Promise<void> {
  const token = sessionInboxHookToken(logicalSessionToken(address));
  if (!(await deliverToHostedHook(token, delivery)))
    await durableHostFor(token).deliver({ session: address }, delivery);
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
  const durable = hosts().durable;
  return durable === undefined ? true : await durableRunEnded(durable, runId);
}

export async function durableRunEnded(host: DurableHost, runId: string): Promise<boolean> {
  try {
    return !isRunning(await host.runStatus(runId));
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
    return isRunning(await durableHostFor(runId).runStatus(runId));
  } catch (error) {
    return !isRunTargetGone(error);
  }
}

export async function cancelRoutedRun(runId: string, reason: string): Promise<boolean> {
  for (const route of hosts().routes) {
    const cancelled = route.cancelRun(runId, reason);
    if (cancelled !== undefined) return cancelled;
  }
  await durableHostFor(runId).cancelRun(runId, reason);
  return true;
}

export function registerSessionLineStore(sessionId: string, store: SessionLineStore): () => void {
  const { streams } = hosts();
  if (streams.has(sessionId)) throw new Error(`Session "${sessionId}" already has a line store.`);
  streams.set(sessionId, store);
  return () => {
    if (streams.get(sessionId) === store) streams.delete(sessionId);
  };
}

export function sessionLineStore(sessionId: string): SessionLineStore {
  const registered = hosts().streams.get(sessionId);
  if (registered !== undefined) return registered;
  const { durable } = hosts();
  if (durable === undefined) throw new Error(`No host in this realm holds session "${sessionId}".`);
  return durable.lineStore;
}
