import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#setup/scaffold/index.js";
import {
  createPromptCommandOutput,
  withPhase,
  type ChannelSetupAwaitChoice,
  type ChannelSetupChoice,
  type ChannelSetupLog,
} from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { updateSlackChannelConnectorUid } from "#setup/scaffold/update/update-slack-channel.js";

import type { SlackConnectorRef, SlackWorkspaceConnection } from "./slack-connect.js";
import { createSlackConnector, type SlackConnectorCreateDeps } from "./slack-connect-create.js";
import {
  attachSlackConnector,
  cleanupCreatedAttempt,
  CONNECT_LOOKUP_TIMEOUT_MS,
  fetchSlackWorkspace,
  findSlackConnector,
  readProjectLink,
  listSlackConnectors,
  type SlackConnectLifecycleDeps,
  type SlackConnectorCleanupResult,
} from "./slack-connect-lifecycle.js";

// Re-exported so the Connect parsers remain importable from the provisioning
// entry point (and unit-testable alongside it).
export {
  parseCreatedSlackConnector,
  parseSlackConnectorDetails,
  pickSlackConnector,
  type SlackConnectorRef,
} from "./slack-connect.js";

/** Injected for tests; defaults to the real Vercel CLI subprocess primitives. */
export interface SlackbotProvisionDeps extends SlackConnectLifecycleDeps, SlackConnectorCreateDeps {
  /** Test seam for the linked Vercel project and team lookup. */
  readProjectLink?: typeof readProjectLink;
  /** Test seam for the workspace poll's pacing; defaults to a real sleep. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Monotonic-enough clock for enforcing the workspace lookup deadline. */
  now?: () => number;
}

const defaultDeps: SlackbotProvisionDeps = { captureVercel, runVercel, runVercelCaptureStdout };

const realDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal });
const monotonicNow = (): number => performance.now();

/**
 * Existing connectors can precede the Slack browser flow, so their connector
 * details are polled for up to five minutes for `data.slackTeam`.
 */
const WORKSPACE_POLL_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_POLL_INTERVAL_MS = 3_000;

/**
 * Outcome of the Connect create-and-attach sequence for a Slackbot. The
 * discriminant is the complete lifecycle state: `attached` means a connector
 * exists, this project is registered as the trigger destination, and the app
 * is installed into a Slack workspace.
 * `not-installed` means the workspace-install deadline elapsed and any connector
 * created by this attempt was removed. `cleanup-failed` means it may remain and
 * callers must stop rather than create another connector. Attachment setup
 * reports detach and attach failures separately because attach must not run
 * while an old trigger destination may still exist.
 */
export type ProvisionSlackbotResult =
  | { state: "connector-lookup-failed" }
  | { state: "create-failed" }
  | { state: "cancelled" }
  | { state: "existing-not-installed"; connectorUid: string }
  | { state: "cleanup-failed"; connectorUids: readonly string[] }
  | { state: "detach-failed"; connectorUid: string }
  | { state: "attach-failed"; connectorUid: string }
  | { state: "not-installed" }
  | { state: "installation-check-failed"; connectorUid: string }
  | {
      state: "attached";
      connectorUid: string;
      /** Deep link that opens a DM compose with the bot ("chat with your agent"). */
      chatUrl?: string;
      workspaceName?: string;
    };

/** Terminal result of polling connector details for Slack workspace metadata. */
type SlackWorkspacePollResult =
  | { state: "connected"; workspace: SlackWorkspaceConnection }
  | { state: "timed-out" }
  | { state: "failed"; message: string };

/** What one create/reuse → workspace → attach attempt settled on. */
type AttemptOutcome =
  | {
      state: "attached";
      ref: SlackConnectorRef;
      workspace?: SlackWorkspaceConnection;
    }
  | { state: "create-failed" }
  | { state: "unresolved" }
  | { state: "detach-failed"; ref: SlackConnectorRef }
  | { state: "attach-failed"; ref: SlackConnectorRef }
  | { state: "timed-out"; ref: SlackConnectorRef }
  | { state: "failed"; ref: SlackConnectorRef; message: string };

/**
 * Wraps one provisioning step. The headless path gets an ephemeral spinner per
 * step; the interactive path routes those phases through the live status line.
 */
type Phase = <T>(message: string, task: () => Promise<T>) => Promise<T>;

type AttemptSource =
  | { state: "existing"; ref: SlackConnectorRef }
  | { state: "new"; baselineConnectorUids: ReadonlySet<string> };

type ExistingAttemptSource = Extract<AttemptSource, { state: "existing" }>;
type NewAttemptSource = Extract<AttemptSource, { state: "new" }>;

/**
 * Polls connector details until Slack workspace metadata appears, the
 * five-minute deadline passes, or the lookup fails.
 */
async function pollSlackWorkspace(
  deps: SlackbotProvisionDeps,
  projectRoot: string,
  connectorId: string,
  orgId: string | undefined,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  signal?: AbortSignal,
): Promise<SlackWorkspacePollResult> {
  const delay = deps.delay ?? realDelay;
  const now = deps.now ?? monotonicNow;
  const deadline = now() + WORKSPACE_POLL_TIMEOUT_MS;

  while (true) {
    signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) return { state: "timed-out" };

    const lookup = await fetchSlackWorkspace({
      deps,
      projectRoot,
      connectorId,
      orgId,
      onOutput,
      timeoutMs: Math.min(CONNECT_LOOKUP_TIMEOUT_MS, remaining),
      signal,
    });
    signal?.throwIfAborted();
    if (lookup.state !== "pending") return lookup;

    const remainingAfterLookup = deadline - now();
    if (remainingAfterLookup <= 0) return { state: "timed-out" };
    await delay(Math.min(WORKSPACE_POLL_INTERVAL_MS, remainingAfterLookup), signal);
  }
}

function isAbortFromSignal(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
  );
}

function cleanupFailureResult(
  cleanup: Extract<SlackConnectorCleanupResult, { state: "failed" }>,
): Extract<ProvisionSlackbotResult, { state: "cleanup-failed" }> {
  return {
    state: "cleanup-failed",
    connectorUids: cleanup.connectorUids,
  };
}

/**
 * Runs one provisioning attempt end to end. A new connector completes when the
 * CLI's browser verifier succeeds (or connector details prove the workspace
 * connection first). A reused connector must expose workspace metadata before
 * eve attaches this project's trigger route.
 * `onCreated` fires the instant a fresh connector exists so an aborted attempt
 * can remove exactly what it made. The `phase` seam lets each caller route
 * progress through its own transient status surface.
 */
async function runAttempt(input: {
  log: ChannelSetupLog;
  deps: SlackbotProvisionDeps;
  projectRoot: string;
  orgId: string | undefined;
  slug: string;
  source: AttemptSource;
  onOutput: ReturnType<typeof createPromptCommandOutput>;
  signal: AbortSignal | undefined;
  phase: Phase;
  onCreated: (ref: SlackConnectorRef) => void;
}): Promise<AttemptOutcome> {
  const { log, deps, projectRoot, orgId, onOutput, signal, phase } = input;
  let ref: SlackConnectorRef;
  let workspace: SlackWorkspaceConnection | undefined;
  if (input.source.state === "existing") {
    ref = input.source.ref;
  } else {
    const created = await createSlackConnector({
      deps,
      projectRoot,
      orgId,
      slug: input.slug,
      onOutput,
      signal,
      phase,
      onCreated: input.onCreated,
      waitForWorkspace: async (createdRef, workspaceSignal) => {
        const result = await pollSlackWorkspace(
          deps,
          projectRoot,
          createdRef.id,
          orgId,
          onOutput,
          workspaceSignal,
        );
        return result.state === "connected" ? result.workspace : undefined;
      },
    });
    if (created.state === "failed") return { state: "create-failed" };
    if (created.state === "unresolved") {
      log.warning(
        "Vercel did not return an exact Slack connector UID for this request, so eve cannot attach or remove it safely.",
      );
      return { state: "unresolved" };
    }
    ref = created.ref;
    if (created.via === "workspace") workspace = created.workspace;
  }

  if (input.source.state === "existing" && workspace === undefined) {
    const poll = await phase("Waiting for the Slack workspace connection...", () =>
      pollSlackWorkspace(deps, projectRoot, ref.id, orgId, onOutput, signal),
    );
    if (poll.state === "timed-out") return { state: "timed-out", ref };
    if (poll.state === "failed") return { state: "failed", ref, message: poll.message };
    workspace = poll.workspace;
  }

  const attachment = await phase("Configuring Slack event delivery for this agent...", () =>
    attachSlackConnector(deps, projectRoot, ref, onOutput, signal),
  );
  signal?.throwIfAborted();
  if (attachment.state !== "attached") return { state: attachment.state, ref };
  return workspace === undefined
    ? { state: "attached", ref }
    : { state: "attached", ref, workspace };
}

/** How an interactive attempt resolved: the work finished, or the user acted. */
type RaceResult =
  | { via: "work"; outcome: AttemptOutcome }
  | { via: "choice"; choice: string | undefined; settled: AttemptOutcome | undefined };

/**
 * Races one provisioning attempt against an open prompt, under a private abort
 * controller linked to the outer signal. If the attempt finishes first its
 * outcome is returned; if the user acts first (or Esc), the attempt is aborted
 * and awaited to a settled state before returning the choice, so a connector
 * created mid-flight is observed and the caller can remove it. The prompt is
 * always dismissed. An outer abort propagating through the attempt is re-thrown
 * after the same abort-and-settle, leaving cleanup policy to the caller.
 */
async function raceAttemptAgainstChoice(input: {
  prompt: ChannelSetupChoice;
  outerSignal: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<AttemptOutcome>;
}): Promise<RaceResult> {
  const controller = new AbortController();
  const signal = input.outerSignal
    ? AbortSignal.any([input.outerSignal, controller.signal])
    : controller.signal;
  const work = input.run(signal);
  try {
    const winner = await Promise.race([
      work.then((outcome) => ({ via: "work" as const, outcome })),
      input.prompt.choice.then((choice) => ({ via: "choice" as const, choice })),
    ]);
    if (winner.via === "work") return winner;

    controller.abort();
    let settled: AttemptOutcome | undefined;
    try {
      settled = await work;
    } catch (error) {
      if (!isAbortFromSignal(error, signal)) throw error;
    }
    return { via: "choice", choice: winner.choice, settled };
  } catch (error) {
    // An outer abort propagated through the attempt before the prompt settled.
    controller.abort();
    try {
      await work;
    } catch {
      // The caller's re-thrown error carries the authoritative failure.
    }
    throw error;
  } finally {
    input.prompt.close();
  }
}

/**
 * Creates or reuses a Slack connector and points its event destination at eve.
 * A successful `connect create` is the completion boundary for a new browser
 * flow. Existing connectors are verified through their team-scoped detail
 * payload before attachment.
 */
export interface ProvisionSlackbotOptions {
  /**
   * Cancels the caller's whole operation. The promise rejects after attempting
   * cleanup; only the explicit interactive Cancel action returns `cancelled`.
   */
  signal?: AbortSignal;
  /** Concurrent retry/cancel controls supplied by an interactive prompter. */
  awaitChoice?: ChannelSetupAwaitChoice;
}

export async function provisionSlackbot(
  log: ChannelSetupLog,
  projectRoot: string,
  /** Connector short-name passed to `vercel connect create slack --name`. */
  slug: string,
  deps: SlackbotProvisionDeps = defaultDeps,
  options: ProvisionSlackbotOptions = {},
): Promise<ProvisionSlackbotResult> {
  options.signal?.throwIfAborted();
  const onOutput = createPromptCommandOutput(log);
  const cleanupContext = { log, deps, projectRoot, onOutput };
  const projectLink = await (deps.readProjectLink ?? readProjectLink)(projectRoot);
  const projectId = projectLink?.projectId;
  const orgId = projectLink?.orgId;
  const expectedUid = `slack/${slug}`;

  const existing = await withPhase(log, "Checking for an existing Slackbot...", () =>
    findSlackConnector(deps, projectRoot, projectId, expectedUid, onOutput, options.signal),
  );
  options.signal?.throwIfAborted();
  if (existing.state === "failed") {
    log.warning(
      `Could not inspect existing Slack connectors, so eve did not create another one. ${existing.message}`,
    );
    return { state: "connector-lookup-failed" };
  }
  if (projectId === undefined && existing.connectorUids.size > 0) {
    log.warning(
      "Could not verify which Slack connectors belong to this Vercel project, so eve did not create another one. Restore `.vercel/project.json`, then try again.",
    );
    return { state: "connector-lookup-failed" };
  }

  /** Folds a finished attempt into a result, cleaning up terminal abandonments. */
  const finishOutcome = async (
    outcome: AttemptOutcome,
    attempt: AttemptSource,
    cleanupAttempt: () => Promise<SlackConnectorCleanupResult>,
  ): Promise<ProvisionSlackbotResult> => {
    const attemptCreated = attempt.state === "new";
    switch (outcome.state) {
      case "create-failed": {
        if (attemptCreated) {
          const cleanup = await cleanupAttempt();
          if (cleanup.state === "failed") return cleanupFailureResult(cleanup);
        }
        return { state: "create-failed" };
      }
      case "unresolved": {
        if (attemptCreated) {
          const cleanup = await cleanupAttempt();
          if (cleanup.state === "failed") return cleanupFailureResult(cleanup);
        }
        return { state: "create-failed" };
      }
      case "detach-failed":
        log.warning(
          `Could not remove the connector's existing trigger destination. Run \`vercel connect detach ${outcome.ref.uid} --yes\`, then \`vercel connect attach ${outcome.ref.uid} --triggers --trigger-path ${SLACK_CHANNEL_DEFAULT_ROUTE} --yes\`.`,
        );
        return {
          state: "detach-failed",
          connectorUid: outcome.ref.uid,
        };
      case "attach-failed":
        log.warning(
          `Could not register this project as a trigger destination. Run \`vercel connect attach ${outcome.ref.uid} --triggers --trigger-path ${SLACK_CHANNEL_DEFAULT_ROUTE} --yes\` to enable event delivery.`,
        );
        return {
          state: "attach-failed",
          connectorUid: outcome.ref.uid,
        };
      case "attached":
        return outcome.workspace === undefined
          ? { state: "attached", connectorUid: outcome.ref.uid }
          : {
              state: "attached",
              connectorUid: outcome.ref.uid,
              chatUrl: outcome.workspace.workspaceUrl,
              workspaceName: outcome.workspace.workspaceName,
            };
      case "failed":
        // The workspace state is unknown, so the connector is left in place
        // rather than risk destroying a working connection.
        log.warning(`Could not verify the Slack workspace connection. ${outcome.message}`);
        return {
          state: "installation-check-failed",
          connectorUid: outcome.ref.uid,
        };
      case "timed-out": {
        log.warning("The Slackbot did not connect to a Slack workspace in time.");
        if (attemptCreated) {
          const cleanup = await cleanupAttempt();
          if (cleanup.state === "failed") return cleanupFailureResult(cleanup);
        }
        return { state: "not-installed" };
      }
    }
  };

  const cleanupNewAttempt = async (
    attempt: NewAttemptSource,
    createdRef: SlackConnectorRef | undefined,
  ): Promise<SlackConnectorCleanupResult> => {
    return cleanupCreatedAttempt(cleanupContext, {
      expectedUid,
      baselineConnectorUids: attempt.baselineConnectorUids,
      createdRef,
    });
  };

  function attemptInput(attempt: AttemptSource, onCreated: (ref: SlackConnectorRef) => void) {
    return {
      log,
      deps,
      projectRoot,
      orgId,
      slug,
      source: attempt,
      onOutput,
      onCreated,
    };
  }

  async function runExistingConnector(
    attempt: ExistingAttemptSource,
  ): Promise<ProvisionSlackbotResult> {
    const cleanupCurrentAttempt = async (): Promise<SlackConnectorCleanupResult> => ({
      state: "clean",
    });
    const notInstalled = (): ProvisionSlackbotResult => {
      log.warning(
        `The existing Slack connector \`${attempt.ref.uid}\` is not connected to a Slack workspace. eve did not remove it because this run did not create it. If its original browser request is still open, complete it; otherwise run \`vercel connect remove ${attempt.ref.uid} --disconnect-all --yes\` before trying again.`,
      );
      return {
        state: "existing-not-installed",
        connectorUid: attempt.ref.uid,
      };
    };
    const finishExistingOutcome = async (
      outcome: AttemptOutcome,
    ): Promise<ProvisionSlackbotResult> => {
      if (outcome.state === "timed-out") return notInstalled();
      return finishOutcome(outcome, attempt, cleanupCurrentAttempt);
    };

    // An existing connector belongs to a prior run. Reconfigure and inspect it,
    // but never offer a fresh browser request or remove it under this run's
    // ownership.
    if (options.awaitChoice !== undefined) {
      const prompt = options.awaitChoice({
        status: "Waiting for the existing Slack workspace connection...",
        context: "Complete the original setup in the browser",
        actions: [{ value: "cancel", label: "Stop waiting" }],
      });
      const race = await raceAttemptAgainstChoice({
        prompt,
        outerSignal: options.signal,
        run: (signal) =>
          runAttempt({ ...attemptInput(attempt, () => {}), signal, phase: (_m, task) => task() }),
      });
      if (race.via === "work") return finishExistingOutcome(race.outcome);
      if (race.settled?.state === "attached") return finishExistingOutcome(race.settled);
      // The user stopped waiting (or Esc): an existing connector is never ours
      // to remove, so report it as not yet connected.
      return notInstalled();
    }

    const outcome = await runAttempt({
      ...attemptInput(attempt, () => {}),
      signal: options.signal,
      phase: (message, task) => withPhase(log, message, task),
    });
    return finishExistingOutcome(outcome);
  }

  async function runUncontrolledAttempt(
    attempt: NewAttemptSource,
  ): Promise<ProvisionSlackbotResult> {
    let createdRef: SlackConnectorRef | undefined;
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, createdRef);
    // No interactive surface (plain/headless): run the new request to a
    // terminal outcome with per-step spinners; abort/retry are unavailable.
    const work = runAttempt({
      ...attemptInput(attempt, (ref) => {
        createdRef = ref;
      }),
      signal: options.signal,
      phase: (message, task) => withPhase(log, message, task),
    });
    try {
      return await finishOutcome(await work, attempt, cleanupCurrentAttempt);
    } catch (error) {
      if (options.signal?.aborted === true) {
        await cleanupCurrentAttempt();
      }
      throw error;
    }
  }

  type InteractiveAttemptDecision =
    | { state: "finished"; result: ProvisionSlackbotResult }
    | { state: "retry"; source: NewAttemptSource };

  async function runInteractiveAttempt(
    attempt: NewAttemptSource,
    awaitChoice: ChannelSetupAwaitChoice,
  ): Promise<InteractiveAttemptDecision> {
    let createdRef: SlackConnectorRef | undefined;
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, createdRef);
    // Interactive: one prompt races the whole create → attach attempt,
    // so "Try again" / "Cancel" are live even while `connect create` parks on
    // the browser. A user action aborts the attempt and removes its connector.
    const prompt = awaitChoice({
      status: "Waiting for Slack setup to finish...",
      context: "Complete setup in the browser, then wait while eve verifies the connection",
      actions: [
        { value: "retry", label: "Did your browser not open? Try again" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    let race: RaceResult;
    try {
      race = await raceAttemptAgainstChoice({
        prompt,
        outerSignal: options.signal,
        run: (signal) =>
          runAttempt({
            ...attemptInput(attempt, (ref) => {
              createdRef = ref;
            }),
            signal,
            phase:
              log.spinner === undefined
                ? (_message, task) => task()
                : (message, task) => withPhase(log, message, task),
          }),
      });
    } catch (error) {
      // An outer abort tore down the attempt: remove the connector it created.
      await cleanupCurrentAttempt();
      throw error;
    }

    if (race.via === "work") {
      return {
        state: "finished",
        result: await finishOutcome(race.outcome, attempt, cleanupCurrentAttempt),
      };
    }
    // The user acted (or Esc). Keep the connector only if it attached before
    // stopping; otherwise remove what this attempt created before retry/cancel.
    if (race.settled?.state === "attached") {
      return {
        state: "finished",
        result: await finishOutcome(race.settled, attempt, cleanupCurrentAttempt),
      };
    }
    const cleanup = await cleanupCurrentAttempt();
    if (cleanup.state === "failed") {
      return { state: "finished", result: cleanupFailureResult(cleanup) };
    }
    if (race.choice === "retry") {
      const inventory = await withPhase(log, "Checking existing Slack connectors...", () =>
        listSlackConnectors(deps, projectRoot, onOutput, options.signal),
      );
      options.signal?.throwIfAborted();
      if (inventory.state === "failed") {
        log.warning(
          `Could not inspect existing Slack connectors, so eve did not create another one. ${inventory.message}`,
        );
        return { state: "finished", result: { state: "connector-lookup-failed" } };
      }
      return {
        state: "retry",
        source: {
          state: "new",
          baselineConnectorUids: new Set(inventory.connectors.map((connector) => connector.uid)),
        },
      };
    }
    return { state: "finished", result: { state: "cancelled" } };
  }

  if (existing.state === "found") {
    return runExistingConnector({ state: "existing", ref: existing.connector });
  }

  let source: NewAttemptSource = {
    state: "new",
    baselineConnectorUids: existing.connectorUids,
  };
  if (options.awaitChoice === undefined) {
    return runUncontrolledAttempt(source);
  }

  while (true) {
    const decision = await runInteractiveAttempt(source, options.awaitChoice);
    if (decision.state === "finished") return decision.result;
    source = decision.source;
  }
}

/**
 * Patches a connector UID chosen by Connect before the caller deploys the channel definition.
 */
export async function reconcileSlackUid(
  log: ChannelSetupLog,
  projectRoot: string,
  slackbot: ProvisionSlackbotResult,
  expectedUid: string,
): Promise<boolean> {
  if (slackbot.state !== "attached" || slackbot.connectorUid === expectedUid) return true;
  const slackChannelPath = join(projectRoot, "agent/channels/slack.ts");
  const { patched } = await updateSlackChannelConnectorUid(slackChannelPath, slackbot.connectorUid);
  if (!patched) {
    log.warning(
      `Could not patch agent/channels/slack.ts automatically. Update \`connectSlackCredentials("...")\` to \`"${slackbot.connectorUid}"\` and run \`vercel deploy --prod\`.`,
    );
    return false;
  }
  return true;
}
