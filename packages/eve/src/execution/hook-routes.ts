import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { hasRunEnded } from "#execution/workflow-runtime.js";

// Where a payload for a hook token, or a command for a run, goes. A host that keeps sessions and
// runs in this process registers a route for the tokens and runs it holds; everything else is
// Workflow's, reached exactly as before. Code that addresses a run or a caller by token (a task's
// control hook, a child's reply hook, a parent's inbox) goes through here, so it reaches either
// host unchanged.

/** One host's tokens and runs. Each answer is `undefined` for what the host never held. */
export interface HookRoute {
  /**
   * Delivers `payload` to the hook `token` names: `delivered`, or `gone` for one this host held
   * once. Async, so the holder can keep the payload, and it can cross the host's step boundary.
   */
  deliver(token: string, payload: unknown): Promise<"delivered" | "gone" | undefined>;
  /** Whether `runId` ended. */
  runEnded(runId: string): boolean | undefined;
  /** Stops `runId` outright: `true` when it was running here. */
  cancelRun(runId: string, reason: string): boolean | undefined;
}

const ROUTES = Symbol.for("eve.hook-routes");

// Shared across module copies, as Workflow's local world loads its own copy of eve's modules.
function routes(): Set<HookRoute> {
  const holder = globalThis as { [ROUTES]?: Set<HookRoute> };
  return (holder[ROUTES] ??= new Set());
}

/** Routes a host's tokens and runs to it until the returned release. */
export function registerHookRoute(route: HookRoute): () => void {
  routes().add(route);
  return () => {
    routes().delete(route);
  };
}

/**
 * Delivers `payload` to the hook `token` names when a host in this process holds it: `true` once
 * delivered, `false` when no host here ever held it, so it's Workflow's. Throws
 * `HookNotFoundError` for a token a host here held once.
 */
export async function deliverToHostedHook(token: string, payload: unknown): Promise<boolean> {
  for (const route of routes()) {
    const delivered = await route.deliver(token, payload);
    if (delivered === "delivered") return true;
    if (delivered === "gone") throw new HookNotFoundError(token);
  }
  return false;
}

/** Resumes the hook `token` names, wherever it's held. */
export async function resumeRoutedHook(token: string, payload: unknown): Promise<void> {
  if (!(await deliverToHostedHook(token, payload))) await resumeHook(token, payload);
}

/** Whether `runId`, a run a host in this process ran, ended; `undefined` for any other run. */
export function hostedRunEnded(runId: string): boolean | undefined {
  for (const route of routes()) {
    const ended = route.runEnded(runId);
    if (ended !== undefined) return ended;
  }
  return undefined;
}

/** Whether `runId` ended, wherever it ran; a Workflow run not readable yet hasn't. */
export async function routedRunEnded(runId: string): Promise<boolean> {
  return hostedRunEnded(runId) ?? (await hasRunEnded(runId));
}

/** Cancels `runId` outright, wherever it runs. */
export async function cancelRoutedRun(runId: string, reason: string): Promise<void> {
  for (const route of routes()) if (route.cancelRun(runId, reason) !== undefined) return;
  await cancelRun(await getWorld(), runId, { cancelReason: reason });
}
