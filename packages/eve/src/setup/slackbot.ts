import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { readProjectLink } from "#setup/project-resolution.js";
import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#setup/scaffold/index.js";
import {
  createPromptCommandOutput,
  withPhase,
  type ChannelSetupAwaitChoice,
  type ChannelSetupChoice,
  type ChannelSetupLog,
} from "#setup/cli/index.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { updateSlackChannelConnectorUid } from "#setup/scaffold/update/update-slack-channel.js";

import type {
  SlackConnectorDetails,
  SlackConnectorProject,
  SlackConnectorRef,
  SlackTriggerDestination,
  SlackWorkspaceConnection,
} from "./slack-connect.js";
import { createSlackConnector, type SlackConnectorCreateDeps } from "./slack-connect-create.js";
import {
  applySlackRouting,
  cleanupCreatedAttempt,
  CONNECT_LOOKUP_TIMEOUT_MS,
  fetchSlackConnectorDetails,
  fetchSlackWorkspace,
  findFreeSlackConnectorName,
  inspectSlackConnectors,
  type SlackConnectLifecycleDeps,
  type SlackConnectorCleanupResult,
} from "./slack-connect-lifecycle.js";
import {
  describeSlackDestinations,
  isReusableSlackConnector,
  type SlackConnectorInUse,
  orderSlackConnectorCandidates,
  planSlackRouting,
  type SlackConnectorCandidate,
} from "./slack-setup-plan.js";

export type { SlackConnectorCandidate } from "./slack-setup-plan.js";

/** Injected for tests; defaults to the real Vercel CLI subprocess primitives. */
interface SlackbotProvisionDeps extends SlackConnectLifecycleDeps, SlackConnectorCreateDeps {
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

/** A Slack connector that delivers this project's events to eve's Slack route. */
interface SlackbotConnection {
  connectorUid: string;
  /** Deep link that opens a DM compose with the bot ("chat with your agent"). */
  chatUrl?: string;
  workspaceName?: string;
}

/**
 * Outcome of Slackbot provisioning. `attached` means a connector exists, this
 * project receives its events at eve's Slack route, and the app is installed
 * into a Slack workspace. `already-configured` is the same state reached
 * without changing anything. `not-installed` means the workspace-install
 * deadline elapsed and any connector created by this attempt was removed.
 * `cleanup-failed` means it may remain and callers must stop rather than
 * create another connector. `trigger-limit-reached` changed nothing because
 * the connector already has the maximum number of trigger destinations.
 * `connector-in-use` changed nothing because another project uses the chosen
 * connector and a second agent on one Slack app would answer the same events.
 */
export type ProvisionSlackbotResult =
  | { state: "connector-lookup-failed" }
  /** `detail` is the Vercel CLI's own error line, when it printed one. */
  | { state: "create-failed"; detail?: string }
  | { state: "cancelled" }
  | { state: "existing-not-installed"; connectorUid: string }
  | { state: "cleanup-failed"; connectorUids: readonly string[] }
  | { state: "attach-failed"; connectorUid: string }
  | {
      state: "connector-in-use";
      connectorUid: string;
      projects: readonly SlackConnectorProject[];
    }
  | {
      state: "trigger-limit-reached";
      connectorUid: string;
      destinations: readonly SlackTriggerDestination[];
    }
  | { state: "not-installed" }
  | { state: "installation-check-failed"; connectorUid: string }
  | ({ state: "attached" } & SlackbotConnection)
  | ({ state: "already-configured" } & SlackbotConnection);

/** Terminal result of polling connector details for Slack workspace metadata. */
type SlackWorkspacePollResult =
  | { state: "connected"; workspace: SlackWorkspaceConnection; details: SlackConnectorDetails }
  | { state: "timed-out" }
  | { state: "failed"; message: string };

/** What one create/reuse → workspace → routing attempt settled on. */
type AttemptOutcome =
  | {
      state: "attached";
      ref: SlackConnectorRef;
      workspace?: SlackWorkspaceConnection;
      /** False only when the connector was already fully configured. */
      changed: boolean;
    }
  | { state: "create-failed"; detail?: string }
  | { state: "unresolved" }
  | { state: "attach-failed"; ref: SlackConnectorRef; message?: string }
  | {
      state: "limit-reached";
      ref: SlackConnectorRef;
      destinations: readonly SlackTriggerDestination[];
      description: readonly string[];
    }
  | { state: "timed-out"; ref: SlackConnectorRef }
  | { state: "failed"; ref: SlackConnectorRef; message: string };

/**
 * Wraps one provisioning step. The headless path gets an ephemeral spinner per
 * step; the interactive path routes those phases through the live status line.
 */
type Phase = <T>(message: string, task: () => Promise<T>) => Promise<T>;

type AttemptSource =
  | { state: "existing"; candidate: SlackConnectorCandidate }
  /** `name` is the `--name` for `connect create`, already checked against the team. */
  | { state: "new"; name: string };

type ExistingAttemptSource = Extract<AttemptSource, { state: "existing" }>;

/**
 * What one new-connector attempt observed, so cleanup removes exactly what it
 * created and knows whether the browser flow could have created anything.
 */
interface CreateAttemptTrace {
  createdRef?: SlackConnectorRef;
  browserStarted: boolean;
}
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
 * Opens Vercel Connect's install page for an existing connector, the page
 * `vercel connect token` opens on `installation_required`. The browser flow
 * that created a connector is its only other install path, and it is gone
 * once that run stops. Connect keys the browser result to the request code;
 * eve observes completion through `data.slackTeam` instead, so the verifier
 * is never kept.
 */
function openSlackInstall(
  log: ChannelSetupLog,
  ref: SlackConnectorRef,
  orgId: string | undefined,
): void {
  if (orgId === undefined) {
    log.info(`Run \`vercel connect open ${ref.uid}\` to install it in a Slack workspace.`);
    return;
  }
  const verifier = randomBytes(37).toString("base64url");
  const url = new URL(`https://vercel.com/api/v1/connect/install/${encodeURIComponent(ref.id)}`);
  url.searchParams.set("teamId", orgId);
  url.searchParams.set("request_code", createHash("sha256").update(verifier).digest("base64url"));
  log.info(`Install \`${ref.uid}\` in a Slack workspace: ${url.href}`);
  openUrl(url.href);
}

/**
 * Explains why a new connector won't carry the agent's name, naming the
 * projects that hold `slack/<slug>` when this snapshot knows them.
 */
function renamedConnectorMessage(
  slug: string,
  name: string,
  inUse: readonly SlackConnectorInUse[],
): string {
  const holder = inUse.find((entry) => entry.uid === `slack/${slug}`);
  if (holder === undefined) {
    return `A Slack connector named \`slack/${slug}\` already exists, so eve will name the new one \`slack/${name}\`.`;
  }
  const projects = holder.otherProjects.map((project) => project.name ?? project.id);
  const owner = projects.length === 1 ? "another project" : "other projects";
  return `\`slack/${slug}\` is already used by ${owner} (${projects.join(", ")}), so eve will create \`slack/${name}\` for this project.`;
}

/** Explains why setup won't attach a connector another project uses. */
export function connectorInUseMessage(candidate: SlackConnectorInUse): string {
  const projects = candidate.otherProjects.map((project) => project.name ?? project.id).join(", ");
  return `\`${candidate.uid}\` is used by ${projects}. eve does not add a second agent to one Slack app because both would respond to the same events. Create a new Slack app for this agent instead.`;
}

/**
 * Runs one provisioning attempt end to end. A new connector completes when the
 * CLI's browser verifier succeeds (or connector details prove the workspace
 * connection first); its destinations are then read fresh. A reused connector
 * must expose workspace metadata before eve changes its event delivery.
 * Routing runs only the mutation the destinations still need, so an attempt
 * over an already-configured connector changes nothing.
 * `trace` records a fresh connector the instant it exists, and whether the
 * browser flow started, so an aborted attempt can remove exactly what it made. The `phase` seam lets each caller route
 * progress through its own transient status surface.
 */
async function runAttempt(input: {
  log: ChannelSetupLog;
  deps: SlackbotProvisionDeps;
  projectRoot: string;
  projectId: string;
  orgId: string | undefined;
  source: AttemptSource;
  onOutput: ReturnType<typeof createPromptCommandOutput>;
  signal: AbortSignal | undefined;
  phase: Phase;
  trace: CreateAttemptTrace;
}): Promise<AttemptOutcome> {
  const { log, deps, projectRoot, projectId, orgId, onOutput, signal, phase } = input;
  let ref: SlackConnectorRef;
  let workspace: SlackWorkspaceConnection | undefined;
  let destinations: readonly SlackTriggerDestination[];
  let attached: boolean;
  let otherProjects: SlackConnectorCandidate["otherProjects"] = [];
  let waited = false;
  if (input.source.state === "existing") {
    const { candidate } = input.source;
    ref = { uid: candidate.uid, id: candidate.id };
    workspace = candidate.workspace;
    destinations = candidate.triggerDestinations;
    attached = candidate.attached;
    otherProjects = candidate.otherProjects;
    if (workspace === undefined) {
      openSlackInstall(log, ref, orgId);
      const poll = await phase("Waiting for the Slack workspace install...", () =>
        pollSlackWorkspace(deps, projectRoot, ref.id, orgId, onOutput, signal),
      );
      if (poll.state === "timed-out") return { state: "timed-out", ref };
      if (poll.state === "failed") return { state: "failed", ref, message: poll.message };
      workspace = poll.workspace;
      destinations = poll.details.triggerDestinations;
      waited = true;
    }
  } else {
    const created = await createSlackConnector({
      deps,
      projectRoot,
      orgId,
      slug: input.source.name,
      onOutput,
      signal,
      phase,
      onCreated: (createdRef) => {
        input.trace.createdRef = createdRef;
      },
      onBrowserStarted: () => {
        input.trace.browserStarted = true;
      },
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
    if (created.state === "failed") {
      return created.detail === undefined
        ? { state: "create-failed" }
        : { state: "create-failed", detail: created.detail };
    }
    if (created.state === "unresolved") {
      log.warning(
        "Vercel did not return an exact Slack connector UID for this request, so eve cannot attach or remove it safely.",
      );
      return { state: "unresolved" };
    }
    ref = created.ref;
    if (created.via === "workspace") workspace = created.workspace;
    // Connect adds a default destination at creation whose path depends on
    // whether it already recognizes the project as eve, so read it back.
    const details = await fetchSlackConnectorDetails({
      deps,
      projectRoot,
      connectorId: ref.id,
      orgId,
      onOutput,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
      signal,
    });
    signal?.throwIfAborted();
    if (details.state === "failed") {
      return { state: "attach-failed", ref, message: details.message };
    }
    destinations = details.details.triggerDestinations;
    workspace ??= details.details.workspace;
    // `connect create` runs in the linked directory, which attaches the project.
    attached = true;
  }

  const plan = planSlackRouting({
    attached,
    destinations,
    projectId,
    route: SLACK_CHANNEL_DEFAULT_ROUTE,
  });
  if (plan.kind === "limit-reached") {
    const projectNames = new Map(
      otherProjects.map((project) => [project.id, project.name ?? project.id]),
    );
    projectNames.set(projectId, "this project");
    return {
      state: "limit-reached",
      ref,
      destinations: plan.destinations,
      description: describeSlackDestinations(plan.destinations, projectNames),
    };
  }
  if (plan.kind !== "none") {
    const routing = await phase("Configuring Slack event delivery for this agent...", () =>
      applySlackRouting({ deps, projectRoot, ref, plan, orgId, onOutput, signal }),
    );
    signal?.throwIfAborted();
    if (routing.state === "attach-failed") return { state: "attach-failed", ref };
  }
  const changed = waited || plan.kind !== "none" || input.source.state === "new";
  return workspace === undefined
    ? { state: "attached", ref, changed }
    : { state: "attached", ref, workspace, changed };
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

/** A team connector to reuse, or a request to create a new one. */
export type SlackConnectorSelection = SlackConnectorRef | "create";

/** Read-only view of the team's Slack connectors relative to the linked project. */
export interface SlackbotConnectorInspection {
  /**
   * Reusable connectors in question order: the suggestion first, then
   * attached, then the rest. Connectors other projects use are excluded.
   */
  candidates: readonly SlackConnectorCandidate[];
  preferred?: SlackConnectorCandidate;
  /** Connectors other projects use, which setup never attaches to this one. */
  inUse: readonly SlackConnectorInUse[];
}

const UNLINKED_PROJECT_WARNING =
  "Slack setup with Vercel Connect needs a linked Vercel project to tell which Slack connectors belong to it, so eve did not create one. Run `vercel link`, then try again.";

type OrderedInspection =
  | (SlackbotConnectorInspection & { state: "ok"; knownUids: ReadonlyMap<string, boolean> })
  | { state: "failed"; message: string };

async function inspectOrdered(input: {
  deps: SlackbotProvisionDeps;
  projectRoot: string;
  projectId: string;
  orgId: string | undefined;
  slug: string;
  channelConnectorUid: string | undefined;
  onOutput: ReturnType<typeof createPromptCommandOutput>;
  signal: AbortSignal | undefined;
}): Promise<OrderedInspection> {
  const expectedUid = `slack/${input.slug}`;
  const namedUids = new Set([expectedUid]);
  if (input.channelConnectorUid !== undefined) namedUids.add(input.channelConnectorUid);
  const inspection = await inspectSlackConnectors({ ...input, namedUids });
  if (inspection.state === "failed") {
    return {
      state: "failed",
      message: `Could not inspect existing Slack connectors, so eve did not create another one. ${inspection.message}`,
    };
  }
  const ordered = orderSlackConnectorCandidates(
    inspection.candidates.filter(isReusableSlackConnector),
    { expectedUid, channelConnectorUid: input.channelConnectorUid },
  );
  return {
    state: "ok",
    ...ordered,
    inUse: inspection.candidates.filter((candidate) => !isReusableSlackConnector(candidate)),
    knownUids: inspection.knownUids,
  };
}

/** Snapshot used to resolve the create/reuse decision before provisioning. */
export async function inspectSlackbotConnectors(
  log: ChannelSetupLog,
  projectRoot: string,
  slug: string,
  options: { signal?: AbortSignal; channelConnectorUid?: string | undefined } = {},
  deps: SlackbotProvisionDeps = defaultDeps,
): Promise<SlackbotConnectorInspection> {
  const projectLink = await (deps.readProjectLink ?? readProjectLink)(projectRoot);
  if (projectLink?.projectId === undefined) throw new Error(UNLINKED_PROJECT_WARNING);
  const inspection = await withPhase(log, "Checking existing Slack connectors...", () =>
    inspectOrdered({
      deps,
      projectRoot,
      projectId: projectLink.projectId,
      orgId: projectLink.orgId,
      slug,
      channelConnectorUid: options.channelConnectorUid,
      onOutput: createPromptCommandOutput(log),
      signal: options.signal,
    }),
  );
  if (inspection.state === "failed") throw new Error(inspection.message);
  const { candidates, preferred, inUse } = inspection;
  return preferred === undefined ? { candidates, inUse } : { candidates, preferred, inUse };
}

interface ProvisionSlackbotOptions {
  /**
   * Cancels the caller's whole operation. The promise rejects after attempting
   * cleanup; only the explicit interactive Cancel action returns `cancelled`.
   */
  signal?: AbortSignal;
  /**
   * Chooses a reusable Slack connector or requests a new one. Candidates are
   * connectors attached to this project or used by no other project; each
   * carries whether it is attached, installed in a workspace, and already
   * delivering to eve's Slack route. Defaults to `preferred`, or a new
   * connector when nothing is suggested.
   */
  selectConnector?: (
    candidates: readonly SlackConnectorCandidate[],
    preferred: SlackConnectorCandidate | undefined,
  ) => Promise<SlackConnectorSelection>;
  /** Connector UID already named by `agent/channels/slack.ts`; suggested first. */
  channelConnectorUid?: string | undefined;
  /** Concurrent retry/cancel controls supplied by an interactive prompter. */
  awaitChoice?: ChannelSetupAwaitChoice;
}

/**
 * Creates or reuses a Slack connector and points its event destination at
 * eve, running only the steps the connector still needs. Re-running it after
 * a partial failure resumes where the previous run stopped; it never detaches
 * a project. A successful `connect create` is the completion boundary for a
 * new browser flow. Existing connectors are verified through their
 * team-scoped detail payload before any change.
 */
export async function provisionSlackbot(
  log: ChannelSetupLog,
  projectRoot: string,
  /**
   * Preferred connector short-name for `vercel connect create slack --name`;
   * suffixed when a team connector already uses it.
   */
  slug: string,
  deps: SlackbotProvisionDeps = defaultDeps,
  options: ProvisionSlackbotOptions = {},
): Promise<ProvisionSlackbotResult> {
  options.signal?.throwIfAborted();
  const onOutput = createPromptCommandOutput(log);
  const projectLink = await (deps.readProjectLink ?? readProjectLink)(projectRoot);
  const orgId = projectLink?.orgId;
  const cleanupContext = { log, deps, projectRoot, orgId, onOutput };
  if (projectLink?.projectId === undefined) {
    log.warning(UNLINKED_PROJECT_WARNING);
    return { state: "connector-lookup-failed" };
  }
  const projectId = projectLink.projectId;

  const inspection = await withPhase(log, "Checking for an existing Slackbot...", () =>
    inspectOrdered({
      deps,
      projectRoot,
      projectId,
      orgId,
      slug,
      channelConnectorUid: options.channelConnectorUid,
      onOutput,
      signal: options.signal,
    }),
  );
  options.signal?.throwIfAborted();
  if (inspection.state === "failed") {
    log.warning(inspection.message);
    return { state: "connector-lookup-failed" };
  }

  const findFreeName = async (knownUids?: ReadonlyMap<string, boolean>) => {
    const free = await findFreeSlackConnectorName({
      deps,
      projectRoot,
      orgId,
      slug,
      knownUids,
      onOutput,
      signal: options.signal,
    });
    if (free.state === "failed") {
      log.warning(`Could not pick a name for the new Slack connector. ${free.message}`);
    }
    return free;
  };

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
        return outcome.detail === undefined
          ? { state: "create-failed" }
          : { state: "create-failed", detail: outcome.detail };
      }
      case "unresolved": {
        if (attemptCreated) {
          const cleanup = await cleanupAttempt();
          if (cleanup.state === "failed") return cleanupFailureResult(cleanup);
        }
        return { state: "create-failed" };
      }
      case "attach-failed":
        log.warning(
          `Could not register ${SLACK_CHANNEL_DEFAULT_ROUTE} on this project as a trigger destination for \`${outcome.ref.uid}\`.${outcome.message === undefined ? "" : ` ${outcome.message}`} eve kept the connector; re-run \`eve add channel/slack\` to finish event delivery.`,
        );
        return {
          state: "attach-failed",
          connectorUid: outcome.ref.uid,
        };
      case "limit-reached":
        log.warning(
          [
            `\`${outcome.ref.uid}\` already has ${outcome.destinations.length} trigger destinations, the most Vercel Connect allows, so eve changed nothing:`,
            ...outcome.description.map((line) => `  - ${line}`),
            "Remove one in the Connect dashboard, then re-run `eve add channel/slack`.",
          ].join("\n"),
        );
        return {
          state: "trigger-limit-reached",
          connectorUid: outcome.ref.uid,
          destinations: outcome.destinations,
        };
      case "attached": {
        const state =
          attempt.state === "existing" && !outcome.changed ? "already-configured" : "attached";
        return outcome.workspace === undefined
          ? { state, connectorUid: outcome.ref.uid }
          : {
              state,
              connectorUid: outcome.ref.uid,
              chatUrl: outcome.workspace.workspaceUrl,
              workspaceName: outcome.workspace.workspaceName,
            };
      }
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
    trace: CreateAttemptTrace,
  ): Promise<SlackConnectorCleanupResult> => {
    return cleanupCreatedAttempt(cleanupContext, {
      expectedUid: `slack/${attempt.name}`,
      createdRef: trace.createdRef,
      browserStarted: trace.browserStarted,
    });
  };

  function attemptInput(attempt: AttemptSource, trace: CreateAttemptTrace) {
    return {
      log,
      deps,
      projectRoot,
      projectId,
      orgId,
      source: attempt,
      onOutput,
      trace,
    };
  }

  async function runExistingConnector(
    attempt: ExistingAttemptSource,
  ): Promise<ProvisionSlackbotResult> {
    const cleanupCurrentAttempt = async (): Promise<SlackConnectorCleanupResult> => ({
      state: "clean",
    });
    const uid = attempt.candidate.uid;
    const notInstalled = (): ProvisionSlackbotResult => {
      log.warning(
        `The Slack connector \`${uid}\` is not installed in a Slack workspace yet. Re-run \`eve add channel/slack\` to open its install page again, or choose "Create a new Slack app" instead.`,
      );
      return {
        state: "existing-not-installed",
        connectorUid: uid,
      };
    };
    const finishExistingOutcome = async (
      outcome: AttemptOutcome,
    ): Promise<ProvisionSlackbotResult> => {
      if (outcome.state === "timed-out") return notInstalled();
      return finishOutcome(outcome, attempt, cleanupCurrentAttempt);
    };

    // An existing connector belongs to a prior run. Reconfigure it and open its
    // install page when needed, but never remove it under this run's
    // ownership. Only a workspace wait is worth racing against a prompt.
    if (options.awaitChoice !== undefined && attempt.candidate.workspace === undefined) {
      while (true) {
        const prompt = options.awaitChoice({
          status: "Waiting for the Slack workspace install...",
          context: "Install the Slack app in your browser, then wait while eve verifies it",
          actions: [
            { value: "retry", label: "Did your browser not open? Try again" },
            { value: "cancel", label: "Stop waiting" },
          ],
        });
        const race = await raceAttemptAgainstChoice({
          prompt,
          outerSignal: options.signal,
          run: (signal) =>
            runAttempt({
              ...attemptInput(attempt, { browserStarted: false }),
              signal,
              phase: (_m, task) => task(),
            }),
        });
        if (race.via === "work") return finishExistingOutcome(race.outcome);
        if (race.settled?.state === "attached") return finishExistingOutcome(race.settled);
        if (race.choice === "retry") continue;
        // The user stopped waiting (or Esc): an existing connector is never ours
        // to remove, so report it as not yet installed.
        return notInstalled();
      }
    }

    const outcome = await runAttempt({
      ...attemptInput(attempt, { browserStarted: false }),
      signal: options.signal,
      phase: (message, task) => withPhase(log, message, task),
    });
    return finishExistingOutcome(outcome);
  }

  async function runUncontrolledAttempt(
    attempt: NewAttemptSource,
  ): Promise<ProvisionSlackbotResult> {
    const trace: CreateAttemptTrace = { browserStarted: false };
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, trace);
    // No interactive surface (plain/headless): run the new request to a
    // terminal outcome with per-step spinners; abort/retry are unavailable.
    const work = runAttempt({
      ...attemptInput(attempt, trace),
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
    const trace: CreateAttemptTrace = { browserStarted: false };
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, trace);
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
            ...attemptInput(attempt, trace),
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
      const free = await withPhase(log, "Checking existing Slack connectors...", () =>
        findFreeName(),
      );
      options.signal?.throwIfAborted();
      if (free.state === "failed") {
        return { state: "finished", result: { state: "connector-lookup-failed" } };
      }
      return { state: "retry", source: { state: "new", name: free.name } };
    }
    return { state: "finished", result: { state: "cancelled" } };
  }

  const { candidates, preferred } = inspection;
  const selection =
    options.selectConnector === undefined
      ? (preferred ?? "create")
      : await options.selectConnector(candidates, preferred);
  options.signal?.throwIfAborted();
  if (selection !== "create") {
    const inUse = inspection.inUse.find((entry) => entry.uid === selection.uid);
    if (inUse !== undefined) {
      log.warning(connectorInUseMessage(inUse));
      return {
        state: "connector-in-use",
        connectorUid: inUse.uid,
        projects: inUse.otherProjects,
      };
    }
    const candidate = candidates.find((entry) => entry.uid === selection.uid);
    if (candidate === undefined) {
      log.warning(
        `The Slack connector \`${selection.uid}\` is no longer in this team, so eve did not change anything. Re-run \`eve add channel/slack\` to choose again.`,
      );
      return { state: "connector-lookup-failed" };
    }
    return runExistingConnector({ state: "existing", candidate });
  }

  const free = await findFreeName(inspection.knownUids);
  options.signal?.throwIfAborted();
  if (free.state === "failed") return { state: "connector-lookup-failed" };
  if (free.name !== slug) log.info(renamedConnectorMessage(slug, free.name, inspection.inUse));
  let source: NewAttemptSource = { state: "new", name: free.name };
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
  if (slackbot.state !== "attached" && slackbot.state !== "already-configured") return true;
  if (slackbot.connectorUid === expectedUid) return true;
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
