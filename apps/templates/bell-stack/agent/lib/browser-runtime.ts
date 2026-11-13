import { personalBrowserEnabled, withPersonalBrowserLock } from "../../server/onepassword/browser-policy";
import {
  createAgentContext,
  ensureAgentContext,
  isDraftAgentContext,
  listAgentContexts,
  promoteAgentContext,
  selectAgentContext,
} from "../../server/browser/agent-contexts.js";
import { BrowserSession, CaptchaHandoffError } from "../../server/browser/browser-session.js";
import { withBrowserPrivacyLock } from "../../server/browser/privacy-lock";
import type { BrowserProxyLocation, ConversationState, TraceEvent } from "../../server/browser/types.js";
import { runWithCancellation } from "./cancellation";
import {
  applyCaptchaTransition,
  closeTaskBrowser,
  reconcileCaptchaAfterRestart,
  recordTaskBrowserContext,
  setTaskBrowserContext,
  taskState,
  updateTaskBrowser,
  type DurableCaptchaRecord,
} from "./task-state";

type BrowserOperation<T> = (browser: BrowserSession) => Promise<T>;

interface BrowserRuntime {
  browser: BrowserSession;
  state: ConversationState;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

export interface BrowserToolOutput<T> {
  result: T;
  workbench: {
    browser: ConversationState["browser"];
    traces: TraceEvent[];
    screenshotDataUrl?: string;
    captcha?: DurableCaptchaRecord;
  };
}

const runtimes = new Map<string, BrowserRuntime>();
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

function getRuntime(sessionId: string): BrowserRuntime {
  const current = runtimes.get(sessionId);
  if (current) return current;

  const saved = taskState.get();
  const durable = reconcileCaptchaAfterRestart(saved, new Date().toISOString());
  if (durable !== saved) taskState.update(() => durable);
  const state: ConversationState = {
    id: sessionId,
    traces: [],
    browser: {
      provider: durable.browser.sessionId ? "browserbase" : "not-started",
      status: "idle",
      contextId: durable.browser.contextId,
      contextStatus: durable.browser.contextStatus,
      proxyLocation: durable.browser.proxyLocation,
      sessionId: durable.browser.sessionId,
      url: durable.browser.url,
      title: durable.browser.title,
    },
  };
  const runtime = {
    state,
    browser: createRuntimeBrowser(
      sessionId,
      state,
      durable.browser.contextId,
      durable.browser.proxyLocation,
    ),
  };
  runtimes.set(sessionId, runtime);
  return runtime;
}

export async function runBrowserOperation<T>(
  sessionId: string,
  operation: BrowserOperation<T>,
  includeScreenshot = false,
): Promise<BrowserToolOutput<T>> {
  return withBrowserPrivacyLock(sessionId,
    () => withPersonalBrowserLock(sessionId, () => runBrowserOperationUnlocked(sessionId, operation, includeScreenshot)),
    undefined, Boolean(taskState.get().browser.sessionId));
}

async function runBrowserOperationUnlocked<T>(sessionId: string, operation: BrowserOperation<T>, includeScreenshot: boolean): Promise<BrowserToolOutput<T>> {
  const runtime = getRuntime(sessionId);
  scheduleIdleClose(sessionId, runtime);
  const traceStart = runtime.state.traces.length;
  let settled = false;
  const pending = operation(runtime.browser).finally(() => {
    settled = true;
  });
  while (!settled) {
    await Promise.race([
      pending.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    commitCaptchaQueue(runtime);
  }
  let result: T;
  try {
    result = await pending;
  } catch (error) {
    if (!(error instanceof CaptchaHandoffError)) throw error;
    result = {
      status: "waiting_for_user",
      reason: "captcha",
      action: "Complete the challenge in the existing Live View, then resume this task.",
    } as T;
  }
  commitCaptchaQueue(runtime);
  scheduleIdleClose(sessionId, runtime);
  return {
    result,
    workbench: {
      browser: { ...runtime.state.browser },
      traces: runtime.state.traces.slice(traceStart),
      captcha: taskState.get().captcha,
      ...(includeScreenshot && runtime.state.screenshot
        ? {
            screenshotDataUrl: `data:image/png;base64,${runtime.state.screenshot.toString("base64")}`,
          }
        : {}),
    },
  };
}

function commitCaptchaQueue(runtime: BrowserRuntime): void {
  const transitions = runtime.browser.drainCaptchaTransitions();
  if (!transitions.length) return;
  taskState.update((current) => {
    let next = current;
    for (const transition of transitions) next = applyCaptchaTransition(next, transition);
    return updateTaskBrowser(next, runtime.state.browser);
  });
}

export async function saveBrowserRuntime(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (runtime)
    taskState.update((current) => updateTaskBrowser(current, runtime.state.browser));
}

export async function closeBrowserRuntime(sessionId: string): Promise<void> {
  // Terminal cleanup can run in a new worker after the last turn. Recover the
  // persisted browser ID without opening another browser or creating a Context.
  const runtime =
    runtimes.get(sessionId) ??
    (taskState.get().browser.sessionId ? getRuntime(sessionId) : undefined);
  if (runtime) {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.closing ??= runtime.browser.close().then(() => {
      runtimes.delete(sessionId);
      taskState.update((current) =>
        closeTaskBrowser(updateTaskBrowser(current, runtime.state.browser)),
      );
    }).finally(() => { runtime.closing = undefined; });
    return runtime.closing;
  }
  taskState.update(closeTaskBrowser);
}

export async function runCancelableBrowserWork<T>(
  sessionId: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return runWithCancellation(signal, operation, () => closeBrowserRuntime(sessionId));
}

export function hasBrowserRuntime(sessionId: string): boolean {
  return runtimes.has(sessionId);
}

export function resumeBrowserAfterHumanInput(sessionId: string): void {
  runtimes.get(sessionId)?.browser.resumeAfterHumanInput();
}

export async function createBrowserContext(
  sessionId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{
  id: string;
  name: string;
  selected: true;
  migratedCookieCount: number;
}> {
  signal?.throwIfAborted();
  const durable = taskState.get();
  const runtime =
    runtimes.get(sessionId) ?? (durable.browser.sessionId ? getRuntime(sessionId) : undefined);
  const currentContextId = durable.browser.contextId;
  if (currentContextId && (await isDraftAgentContext(currentContextId, sessionId))) {
    signal?.throwIfAborted();
    const context = await promoteAgentContext(currentContextId, name);
    signal?.throwIfAborted();
    taskState.update((current) => recordTaskBrowserContext(current, context.id, "saved"));
    if (runtime) runtime.state.browser.contextStatus = "saved";
    return {
      id: context.id,
      name: context.name,
      selected: true,
      migratedCookieCount: 0,
    };
  }
  const hasExistingBrowser = Boolean(
    runtime?.browser.hasStarted() || runtime?.state.browser.sessionId,
  );
  signal?.throwIfAborted();
  if (hasExistingBrowser) await runtime!.browser.start();
  signal?.throwIfAborted();
  const cookies = hasExistingBrowser ? await runtime!.browser.exportCookies() : [];
  signal?.throwIfAborted();
  const url = runtime?.state.browser.url;
  const context = await createAgentContext(name);
  signal?.throwIfAborted();
  if (hasExistingBrowser) await runtime!.browser.close();
  signal?.throwIfAborted();
  taskState.update((current) => setTaskBrowserContext(current, context.id));

  if (runtime) {
    runtime.state.browser = {
      provider: "not-started",
      status: "idle",
      contextId: context.id,
      contextStatus: "saved",
    };
    runtime.browser = createRuntimeBrowser(
      sessionId,
      runtime.state,
      context.id,
      runtime.state.browser.proxyLocation,
    );
    if (cookies.length) await runtime.browser.importCookies(cookies, url);
  }

  return {
    id: context.id,
    name: context.name,
    selected: true,
    migratedCookieCount: cookies.length,
  };
}

export async function selectBrowserContext(
  sessionId: string,
  contextId: string,
): Promise<{ id: string; name: string; selected: true }> {
  const runtime = runtimes.get(sessionId);
  if (runtime?.browser.hasStarted() || taskState.get().browser.sessionId) {
    throw new Error("Save or close the current browser before you select another Context.");
  }
  await selectAgentContext(contextId);
  const context = (await listAgentContexts()).find((item) => item.id === contextId);
  if (!context) throw new Error("Unknown Context.");
  taskState.update((current) => setTaskBrowserContext(current, contextId));
  if (runtime) {
    runtime.state.browser.contextId = contextId;
    runtime.state.browser.contextStatus = "saved";
    runtime.browser = createRuntimeBrowser(
      sessionId,
      runtime.state,
      contextId,
      runtime.state.browser.proxyLocation,
    );
  }
  return { id: context.id, name: context.name, selected: true };
}

export async function saveBrowserContext(
  sessionId: string,
  name?: string,
  signal?: AbortSignal,
): Promise<{
  id: string;
  name: string;
  status: "saved";
  migratedCookieCount: number;
}> {
  signal?.throwIfAborted();
  let contextId = taskState.get().browser.contextId;
  let migratedCookieCount = 0;
  if (!contextId) {
    const created = await createBrowserContext(
      sessionId,
      name?.trim() || `Bell ${new Date().toISOString().slice(0, 10)}`,
      signal,
    );
    contextId = created.id;
    migratedCookieCount = created.migratedCookieCount;
  }

  const draft = await isDraftAgentContext(contextId, sessionId);
  signal?.throwIfAborted();
  const contextName = name?.trim() || (draft ? defaultContextName(taskState.get()) : undefined);
  await saveBrowserRuntime(sessionId);
  await closeBrowserRuntime(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  signal?.throwIfAborted();
  const context = await promoteAgentContext(contextId, contextName);
  signal?.throwIfAborted();
  taskState.update((current) => setTaskBrowserContext(current, contextId, "closed", "saved"));
  return {
    id: context.id,
    name: context.name,
    status: "saved",
    migratedCookieCount,
  };
}

function createRuntimeBrowser(
  sessionId: string,
  state: ConversationState,
  contextId?: string,
  proxyLocation?: BrowserProxyLocation,
): BrowserSession {
  return new BrowserSession(state, {
    contextId,
    proxyLocation,
    captcha: taskState.get().captcha,
    ensureContext: personalBrowserEnabled() ? undefined : async (currentContextId) => {
      const context = await ensureAgentContext(sessionId, currentContextId);
      state.browser.contextId = context.id;
      state.browser.contextStatus = context.status;
      taskState.update((current) => recordTaskBrowserContext(current, context.id, context.status));
      return { id: context.id, status: context.status };
    },
  });
}

function defaultContextName(record: { title: string }): string {
  const title = record.title.trim();
  if (title && title !== "New task") return title.slice(0, 80);
  return `Bell ${new Date().toISOString().slice(0, 10)}`;
}

function scheduleIdleClose(sessionId: string, runtime: BrowserRuntime): void {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.closing || runtimes.get(sessionId) !== runtime) return;
  const configured = Number(process.env.BELL_BROWSER_IDLE_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
  runtime.idleTimer = setTimeout(() => {
    if (runtimes.get(sessionId) === runtime)
      void closeBrowserRuntime(sessionId).catch(() => undefined);
  }, timeoutMs);
  runtime.idleTimer.unref?.();
}

// Channel callbacks also run when Eve ends a session outside a turn.
// Global stream hooks do not run on that path in Eve 0.79.1.
export const browserChannelEvents = {
  async "session.completed"(_event: unknown, _channel: unknown, ctx: { session: { id: string } }) {
    await closeBrowserRuntime(ctx.session.id);
  },
  async "session.failed"(event: { sessionId: string }) {
    await closeBrowserRuntime(event.sessionId);
  },
};
