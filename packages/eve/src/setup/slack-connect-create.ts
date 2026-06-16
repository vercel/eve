import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import type { captureVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import {
  parseCreatedSlackConnector,
  type SlackConnectorRef,
  type SlackWorkspaceConnection,
} from "./slack-connect.js";
import {
  CONNECT_LOOKUP_TIMEOUT_MS,
  fetchSlackConnectorDetails,
} from "./slack-connect-lifecycle.js";

export interface SlackConnectorCreateDeps {
  captureVercel: typeof captureVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type SlackConnectorCreateResult =
  | { state: "created"; via: "cli"; ref: SlackConnectorRef }
  | {
      state: "created";
      via: "workspace";
      ref: SlackConnectorRef;
      workspace: SlackWorkspaceConnection;
    }
  | { state: "failed" }
  | { state: "unresolved" };

type Phase = <T>(message: string, task: () => Promise<T>) => Promise<T>;

const CREATE_TIMEOUT_MS = 10 * 60_000;
const LOOKUP_REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_POLL_INTERVAL_MS = 3_000;
const CREATED_CONNECTOR_PROGRESS = /\bConnector created:\s*(scl_[A-Za-z0-9]+)\b/;

const realDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal });
const monotonicNow = (): number => performance.now();

async function pollCreatedSlackConnector(
  deps: SlackConnectorCreateDeps,
  projectRoot: string,
  connectorId: string,
  orgId: string | undefined,
  onOutput: ProcessOutputHandler,
  signal: AbortSignal,
): Promise<SlackConnectorRef | undefined> {
  const delay = deps.delay ?? realDelay;
  const now = deps.now ?? monotonicNow;
  const deadline = now() + CONNECT_LOOKUP_TIMEOUT_MS;

  while (true) {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    const result = await fetchSlackConnectorDetails({
      deps,
      projectRoot,
      connectorId,
      orgId,
      onOutput,
      timeoutMs: Math.min(LOOKUP_REQUEST_TIMEOUT_MS, remaining),
      signal,
    });
    signal.throwIfAborted();
    if (result.state === "found") return result.details.ref;

    const remainingAfterLookup = deadline - now();
    if (remainingAfterLookup <= 0) return undefined;
    await delay(Math.min(LOOKUP_POLL_INTERVAL_MS, remainingAfterLookup), signal);
  }
}

/**
 * Waits for either the CLI's final browser result or connector metadata proving
 * that Slack connected the workspace. A connector progress event establishes
 * ownership only; the exact detail endpoint establishes workspace completion.
 */
export async function createSlackConnector(input: {
  deps: SlackConnectorCreateDeps;
  projectRoot: string;
  orgId: string | undefined;
  slug: string;
  onOutput: ProcessOutputHandler;
  signal: AbortSignal | undefined;
  phase: Phase;
  onCreated: (ref: SlackConnectorRef) => void;
  waitForWorkspace: (
    ref: SlackConnectorRef,
    signal: AbortSignal,
  ) => Promise<SlackWorkspaceConnection | undefined>;
}): Promise<SlackConnectorCreateResult> {
  const createController = new AbortController();
  const lookupController = new AbortController();
  const workspaceController = new AbortController();
  const createSignal = input.signal
    ? AbortSignal.any([input.signal, createController.signal])
    : createController.signal;
  const lookupSignal = input.signal
    ? AbortSignal.any([input.signal, lookupController.signal])
    : lookupController.signal;
  const workspaceSignal = input.signal
    ? AbortSignal.any([input.signal, workspaceController.signal])
    : workspaceController.signal;
  let reported = false;
  const reportCreated = (ref: SlackConnectorRef): void => {
    if (reported) return;
    reported = true;
    input.onCreated(ref);
  };
  let resolveWorkspace!: (result: {
    ref: SlackConnectorRef;
    workspace: SlackWorkspaceConnection;
  }) => void;
  let rejectWorkspace!: (error: unknown) => void;
  const workspaceReady = new Promise<{
    ref: SlackConnectorRef;
    workspace: SlackWorkspaceConnection;
  }>((resolve, reject) => {
    resolveWorkspace = resolve;
    rejectWorkspace = reject;
  });
  let progressLookup: Promise<SlackConnectorRef | undefined> | undefined;
  let workspaceWork: Promise<SlackWorkspaceConnection | undefined> | undefined;
  const startWorkspaceLookup = (ref: SlackConnectorRef): void => {
    if (workspaceWork !== undefined) return;
    workspaceWork = input.waitForWorkspace(ref, workspaceSignal).catch((error: unknown) => {
      if (workspaceController.signal.aborted && input.signal?.aborted !== true) {
        return undefined;
      }
      throw error;
    });
    void workspaceWork.then((workspace) => {
      if (workspace !== undefined) resolveWorkspace({ ref, workspace });
    }, rejectWorkspace);
  };
  const createOutput: ProcessOutputHandler = (line) => {
    input.onOutput(line);
    const connectorId = line.text.match(CREATED_CONNECTOR_PROGRESS)?.[1];
    if (connectorId === undefined || progressLookup !== undefined) return;
    progressLookup = pollCreatedSlackConnector(
      input.deps,
      input.projectRoot,
      connectorId,
      input.orgId,
      input.onOutput,
      lookupSignal,
    ).catch((error: unknown) => {
      if (lookupController.signal.aborted && input.signal?.aborted !== true) return undefined;
      throw error;
    });
    void progressLookup.then((ref) => {
      if (ref === undefined) return;
      reportCreated(ref);
      startWorkspaceLookup(ref);
    }, rejectWorkspace);
  };
  const createWork = input.phase("Waiting for Slack setup to finish...", () =>
    input.deps.runVercelCaptureStdout(
      ["connect", "create", "slack", "--triggers", "--name", input.slug, "-F", "json"],
      {
        cwd: input.projectRoot,
        nonInteractive: true,
        onOutput: createOutput,
        timeoutMs: CREATE_TIMEOUT_MS,
        signal: createSignal,
      },
    ),
  );
  let created:
    | { via: "cli"; result: Awaited<typeof createWork> }
    | { via: "workspace"; ref: SlackConnectorRef; workspace: SlackWorkspaceConnection };
  try {
    created = await Promise.race([
      createWork.then((result) => ({ via: "cli" as const, result })),
      workspaceReady.then((result) => ({ via: "workspace" as const, ...result })),
    ]);
  } catch (error) {
    lookupController.abort();
    workspaceController.abort();
    await Promise.allSettled([progressLookup, workspaceWork].filter((work) => work !== undefined));
    throw error;
  }

  if (created.via === "workspace") {
    createController.abort();
    await createWork;
    input.signal?.throwIfAborted();
    return {
      state: "created",
      via: "workspace",
      ref: created.ref,
      workspace: created.workspace,
    };
  }
  if (!created.result.ok) {
    if (progressLookup !== undefined) await progressLookup;
    workspaceController.abort();
    if (workspaceWork !== undefined) await workspaceWork;
    input.signal?.throwIfAborted();
    return { state: "failed" };
  }

  const finalRef = parseCreatedSlackConnector(created.result.stdout);
  if (finalRef !== undefined) {
    reportCreated(finalRef);
    lookupController.abort();
    workspaceController.abort();
    if (progressLookup !== undefined) await progressLookup;
    if (workspaceWork !== undefined) await workspaceWork;
    input.signal?.throwIfAborted();
    return { state: "created", via: "cli", ref: finalRef };
  }
  const progress = progressLookup === undefined ? undefined : await progressLookup;
  workspaceController.abort();
  if (workspaceWork !== undefined) await workspaceWork;
  input.signal?.throwIfAborted();
  return progress === undefined
    ? { state: "unresolved" }
    : { state: "created", via: "cli", ref: progress };
}
