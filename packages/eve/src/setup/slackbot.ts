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
  refreshSlackCandidate,
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

interface SlackbotProvisionDeps extends SlackConnectLifecycleDeps, SlackConnectorCreateDeps {
  readProjectLink?: typeof readProjectLink;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultDeps: SlackbotProvisionDeps = { captureVercel, runVercel, runVercelCaptureStdout };

const realDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal });
const monotonicNow = (): number => performance.now();

const WORKSPACE_POLL_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_POLL_INTERVAL_MS = 3_000;

interface SlackbotConnection {
  connectorUid: string;
  chatUrl?: string;
  workspaceName?: string;
}

export type ProvisionSlackbotResult =
  | { state: "connector-lookup-failed" }
  | { state: "create-failed"; detail?: string }
  | { state: "cancelled" }
  | { state: "existing-not-installed"; connectorUid: string }
  | { state: "cleanup-failed"; connectorUids: readonly string[] }
  | { state: "attach-failed"; connectorUid: string }
  | { state: "connector-in-use"; connectorUid: string; projects: readonly SlackConnectorProject[] }
  | {
      state: "trigger-limit-reached";
      connectorUid: string;
      destinations: readonly SlackTriggerDestination[];
    }
  | { state: "not-installed" }
  | { state: "installation-check-failed"; connectorUid: string }
  | ({ state: "attached" } & SlackbotConnection)
  | ({ state: "already-configured" } & SlackbotConnection);

type SlackWorkspacePollResult =
  | { state: "connected"; workspace: SlackWorkspaceConnection }
  | { state: "timed-out" }
  | { state: "failed"; message: string };

type AttemptOutcome =
  | {
      state: "attached";
      ref: SlackConnectorRef;
      workspace?: SlackWorkspaceConnection;
      changed: boolean;
    }
  | { state: "create-failed"; detail?: string }
  | { state: "unresolved" }
  | { state: "attach-failed"; ref: SlackConnectorRef; message?: string }
  | { state: "in-use"; ref: SlackConnectorRef; projects: readonly SlackConnectorProject[] }
  | {
      state: "limit-reached";
      ref: SlackConnectorRef;
      destinations: readonly SlackTriggerDestination[];
      description: readonly string[];
    }
  | { state: "timed-out"; ref: SlackConnectorRef }
  | { state: "failed"; ref: SlackConnectorRef; message: string };

type Phase = <T>(message: string, task: () => Promise<T>) => Promise<T>;

type AttemptSource =
  | { state: "existing"; candidate: SlackConnectorCandidate }
  | { state: "new"; name: string };

type ExistingAttemptSource = Extract<AttemptSource, { state: "existing" }>;

interface CreateAttemptTrace {
  createdRef?: SlackConnectorRef;
  rejected: boolean;
}
type NewAttemptSource = Extract<AttemptSource, { state: "new" }>;

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

export function connectorInUseMessage(candidate: SlackConnectorInUse): string {
  const projects = candidate.otherProjects.map((project) => project.name ?? project.id).join(", ");
  return `\`${candidate.uid}\` is used by ${projects}. eve does not add a second agent to one Slack app because both would respond to the same events. Create a new Slack app for this agent instead.`;
}

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
  let attached: boolean;
  let destinations: readonly SlackTriggerDestination[];
  let otherProjects: readonly SlackConnectorProject[] = [];
  let changed = input.source.state === "new";
  if (input.source.state === "existing") {
    const { candidate } = input.source;
    ref = { uid: candidate.uid, id: candidate.id };
    workspace = candidate.workspace;
    if (workspace === undefined) {
      openSlackInstall(log, ref, orgId);
      const poll = await phase("Waiting for the Slack workspace install...", () =>
        pollSlackWorkspace(deps, projectRoot, ref.id, orgId, onOutput, signal),
      );
      if (poll.state === "timed-out") return { state: "timed-out", ref };
      if (poll.state === "failed") return { state: "failed", ref, message: poll.message };
      workspace = poll.workspace;
      changed = true;
    }
    const fresh = await refreshSlackCandidate({
      deps,
      projectRoot,
      candidate,
      projectId,
      orgId,
      onOutput,
      signal,
    });
    signal?.throwIfAborted();
    if (fresh.state === "failed") return { state: "attach-failed", ref, message: fresh.message };
    if (!isReusableSlackConnector(fresh.candidate)) {
      return { state: "in-use", ref, projects: fresh.candidate.otherProjects };
    }
    attached = fresh.candidate.attached;
    destinations = fresh.candidate.triggerDestinations;
    otherProjects = fresh.candidate.otherProjects;
    workspace ??= fresh.candidate.workspace;
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
      input.trace.rejected = created.rejected;
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
    attached = true;
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
    if (details.state === "failed")
      return { state: "attach-failed", ref, message: details.message };
    destinations = details.details.triggerDestinations;
    workspace ??= details.details.workspace;
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
  if (plan.attach || plan.destinations !== undefined) {
    const routing = await phase("Configuring Slack event delivery for this agent...", () =>
      applySlackRouting({ deps, projectRoot, ref, plan, orgId, onOutput, signal }),
    );
    signal?.throwIfAborted();
    if (routing.state === "attach-failed")
      return { state: "attach-failed", ref, message: routing.message };
    changed = true;
  }
  return workspace === undefined
    ? { state: "attached", ref, changed }
    : { state: "attached", ref, workspace, changed };
}

type RaceResult =
  | { via: "work"; outcome: AttemptOutcome }
  | { via: "choice"; choice: string | undefined; settled: AttemptOutcome | undefined };

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
    controller.abort();
    try {
      await work;
    } catch {}
    throw error;
  } finally {
    input.prompt.close();
  }
}

export type SlackConnectorSelection = SlackConnectorCandidate | "create";

export interface SlackbotConnectorInspection {
  projectId: string;
  orgId: string | undefined;
  slug: string;
  candidates: readonly SlackConnectorCandidate[];
  preferred?: SlackConnectorCandidate;
  inUse: readonly SlackConnectorInUse[];
}

const UNLINKED_PROJECT_WARNING =
  "Slack setup with Vercel Connect needs a linked Vercel project to tell which Slack connectors belong to it, so eve did not create one. Run `vercel link`, then try again.";

export async function inspectSlackbotConnectors(
  log: ChannelSetupLog,
  projectRoot: string,
  slug: string,
  options: { signal?: AbortSignal; channelConnectorUid?: string | undefined } = {},
  deps: SlackbotProvisionDeps = defaultDeps,
): Promise<SlackbotConnectorInspection> {
  const projectLink = await (deps.readProjectLink ?? readProjectLink)(projectRoot);
  if (projectLink?.projectId === undefined) throw new Error(UNLINKED_PROJECT_WARNING);
  const { projectId, orgId } = projectLink;
  const { channelConnectorUid } = options;
  const expectedUid = `slack/${slug}`;
  const namedUids = new Set([expectedUid]);
  if (channelConnectorUid !== undefined) namedUids.add(channelConnectorUid);
  const inspection = await withPhase(log, "Checking existing Slack connectors...", () =>
    inspectSlackConnectors({
      deps,
      projectRoot,
      projectId,
      orgId,
      namedUids,
      onOutput: createPromptCommandOutput(log),
      signal: options.signal,
    }),
  );
  if (inspection.state === "failed") {
    throw new Error(
      `Could not inspect existing Slack connectors, so eve did not create another one. ${inspection.message}`,
    );
  }
  return {
    projectId,
    orgId,
    slug,
    ...orderSlackConnectorCandidates(inspection.candidates.filter(isReusableSlackConnector), {
      expectedUid,
      channelConnectorUid,
    }),
    inUse: inspection.candidates.filter((candidate) => !isReusableSlackConnector(candidate)),
  };
}

interface ProvisionSlackbotOptions {
  signal?: AbortSignal;
  awaitChoice?: ChannelSetupAwaitChoice;
}

export async function provisionSlackbot(
  log: ChannelSetupLog,
  projectRoot: string,
  inspection: SlackbotConnectorInspection,
  selection: SlackConnectorSelection,
  deps: SlackbotProvisionDeps = defaultDeps,
  options: ProvisionSlackbotOptions = {},
): Promise<ProvisionSlackbotResult> {
  options.signal?.throwIfAborted();
  const onOutput = createPromptCommandOutput(log);
  const { projectId, orgId, slug } = inspection;
  const cleanupContext = { log, deps, projectRoot, orgId, onOutput };

  const findFreeName = async () => {
    const free = await findFreeSlackConnectorName({
      deps,
      projectRoot,
      orgId,
      slug,
      onOutput,
      signal: options.signal,
    });
    if (free.state === "failed") {
      log.warning(`Could not pick a name for the new Slack connector. ${free.message}`);
    }
    return free;
  };

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
      case "in-use":
        log.warning(
          connectorInUseMessage({ uid: outcome.ref.uid, otherProjects: outcome.projects }),
        );
        return {
          state: "connector-in-use",
          connectorUid: outcome.ref.uid,
          projects: outcome.projects,
        };
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
        const state = outcome.changed ? "attached" : "already-configured";
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
      rejected: trace.rejected,
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
              ...attemptInput(attempt, { rejected: false }),
              signal,
              phase: (_m, task) => task(),
            }),
        });
        if (race.via === "work") return finishExistingOutcome(race.outcome);
        if (race.settled?.state === "attached") return finishExistingOutcome(race.settled);
        if (race.choice === "retry") continue;
        return notInstalled();
      }
    }

    const outcome = await runAttempt({
      ...attemptInput(attempt, { rejected: false }),
      signal: options.signal,
      phase: (message, task) => withPhase(log, message, task),
    });
    return finishExistingOutcome(outcome);
  }

  async function runUncontrolledAttempt(
    attempt: NewAttemptSource,
  ): Promise<ProvisionSlackbotResult> {
    const trace: CreateAttemptTrace = { rejected: false };
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, trace);
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
    const trace: CreateAttemptTrace = { rejected: false };
    const cleanupCurrentAttempt = () => cleanupNewAttempt(attempt, trace);
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
      await cleanupCurrentAttempt();
      throw error;
    }

    if (race.via === "work") {
      return {
        state: "finished",
        result: await finishOutcome(race.outcome, attempt, cleanupCurrentAttempt),
      };
    }
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

  if (selection !== "create") {
    return runExistingConnector({ state: "existing", candidate: selection });
  }

  const free = await findFreeName();
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
