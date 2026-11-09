import { CONNECT_MUTATION_TIMEOUT_MS } from "#setup/connect-provisioning.js";
import { createPromptCommandOutput, type ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel } from "#setup/primitives/run-vercel.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";
import { isNotFoundApiFailure, normalizeVercelApiResult } from "#setup/vercel-api-failure.js";
import {
  parseConnectorProjects,
  parseSlackConnectorDetails,
  parseSlackConnectorPage,
  type RawSlackConnector,
  type SlackConnectorDetails,
  type SlackConnectorProject,
  type SlackConnectorRef,
  type SlackTriggerDestination,
  type SlackWorkspaceConnection,
} from "./slack-connect.js";
import type { SlackConnectorCandidate, SlackRoutingPlan } from "./slack-setup-plan.js";

export const CONNECT_LOOKUP_TIMEOUT_MS = 60_000;

/** Connect subprocess operations needed to inspect and remove Slack connectors. */
export interface SlackConnectLifecycleDeps {
  captureVercel: typeof captureVercel;
  runVercel: typeof runVercel;
}

export type SlackConnectorCleanupResult =
  | { state: "clean" }
  | { state: "failed"; connectorUids: readonly string[] };

type CommandOutput = ReturnType<typeof createPromptCommandOutput>;

type LookupFailure = { state: "failed"; message: string };

/** Shared dependencies and output routing for one connector cleanup operation. */
interface SlackConnectorCleanupContext {
  log: ChannelSetupLog;
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
}

/** `vercel api` arguments for a team-scoped Connect request. */
function connectApiArgs(
  path: string,
  orgId: string | undefined,
  params: Record<string, string> = {},
  flags: readonly string[] = [],
): string[] {
  const query = new URLSearchParams(params);
  if (orgId !== undefined) query.set("teamId", orgId);
  const search = query.toString();
  const args = ["api", search === "" ? path : `${path}?${search}`, ...flags];
  if (orgId !== undefined) args.push("--scope", orgId);
  return args;
}

function connectorPath(key: string): string {
  return `/v1/connect/connectors/${encodeURIComponent(key)}`;
}

/** The largest page the connector list accepts. */
const CONNECTOR_LIST_PAGE_SIZE = 100;
/** Upper bound on list pages so a misbehaving cursor cannot loop forever. */
const MAX_CONNECTOR_LIST_PAGES = 50;

/**
 * Lists the Slack connectors attached to one project, with each connector's
 * attached projects. Connect filters by project server-side, so the team's
 * size doesn't matter.
 */
async function listProjectSlackConnectors(input: {
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  projectId: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<{ state: "ok"; connectors: readonly RawSlackConnector[] } | LookupFailure> {
  const connectors: RawSlackConnector[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTOR_LIST_PAGES; page += 1) {
    const params: Record<string, string> = {
      projectId: input.projectId,
      type: "slack",
      include: "projects",
      limit: String(CONNECTOR_LIST_PAGE_SIZE),
    };
    if (cursor !== undefined) params.cursor = cursor;
    const result = await input.deps.captureVercel(
      connectApiArgs("/v1/connect/connectors", input.orgId, params),
      {
        cwd: input.projectRoot,
        onOutput: input.onOutput,
        timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
        signal: input.signal,
      },
    );
    if (!result.ok) return { state: "failed", message: result.failure.message };

    let parsed: ReturnType<typeof parseSlackConnectorPage>;
    try {
      parsed = parseSlackConnectorPage(JSON.parse(result.stdout));
    } catch {
      return { state: "failed", message: "Vercel returned invalid JSON for the connector list." };
    }
    if (parsed === undefined) {
      return { state: "failed", message: "Vercel returned a malformed connector list." };
    }
    connectors.push(...parsed.connectors);
    if (parsed.next === undefined) return { state: "ok", connectors };
    if (seenCursors.has(parsed.next)) {
      return { state: "failed", message: `The connector list repeated cursor ${parsed.next}.` };
    }
    seenCursors.add(parsed.next);
    cursor = parsed.next;
  }
  return {
    state: "failed",
    message: `The connector list has more than ${MAX_CONNECTOR_LIST_PAGES} pages.`,
  };
}

/**
 * The first page of a connector's attached projects. A connector with more
 * than one page is used elsewhere either way, so later pages never change
 * whether setup may reuse it.
 */
async function fetchConnectorProjects(input: {
  deps: Pick<SlackConnectLifecycleDeps, "captureVercel">;
  projectRoot: string;
  connectorId: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<{ state: "ok"; projects: readonly SlackConnectorProject[] } | LookupFailure> {
  const result = await input.deps.captureVercel(
    connectApiArgs(`${connectorPath(input.connectorId)}/projects`, input.orgId),
    {
      cwd: input.projectRoot,
      onOutput: input.onOutput,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
      signal: input.signal,
    },
  );
  if (!result.ok) return { state: "failed", message: result.failure.message };
  try {
    const projects = parseConnectorProjects(JSON.parse(result.stdout));
    return projects === undefined
      ? { state: "failed", message: "Vercel returned a malformed connector project list." }
      : { state: "ok", projects };
  } catch {
    return {
      state: "failed",
      message: "Vercel returned invalid JSON for the connector project list.",
    };
  }
}

/**
 * Projects other than this one that use the connector, by attachment or by
 * trigger destination.
 */
function otherProjectsOf(
  projects: readonly SlackConnectorProject[],
  destinations: readonly SlackTriggerDestination[],
  projectId: string,
): SlackConnectorProject[] {
  const others = projects.filter((project) => project.id !== projectId);
  for (const destination of destinations) {
    if (destination.projectId === projectId) continue;
    if (others.some((project) => project.id === destination.projectId)) continue;
    others.push({ id: destination.projectId });
  }
  return others;
}

function toCandidate(input: {
  details: SlackConnectorDetails;
  attached: boolean;
  projects: readonly SlackConnectorProject[];
  projectId: string;
  createdAt: number;
}): SlackConnectorCandidate {
  const { details, projectId } = input;
  const destinations = details.triggerDestinations;
  const candidate: SlackConnectorCandidate = {
    ...details.ref,
    attached: input.attached,
    triggerDestinations: destinations,
    otherProjects: otherProjectsOf(input.projects, destinations, projectId),
    createdAt: input.createdAt,
  };
  if (details.workspace !== undefined) candidate.workspace = details.workspace;
  return candidate;
}

/** Detail lookups run a few at a time so many connectors cannot fan out unbounded subprocesses. */
const INSPECTION_CONCURRENCY = 4;

export type SlackConnectorInspection =
  | {
      state: "ok";
      /** Connectors attached to this project or found by UID, with details. */
      candidates: readonly SlackConnectorCandidate[];
    }
  | LookupFailure;

/**
 * Read-only snapshot of the Slack connectors that matter to the linked
 * project: those attached to it, plus `namedUids` looked up directly. Each
 * carries its attachment, workspace installation, and trigger destination.
 * Any unreadable connector fails the whole snapshot so setup never guesses.
 */
export async function inspectSlackConnectors(input: {
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  projectId: string;
  orgId: string | undefined;
  /**
   * UIDs to look up even when this project isn't attached: the channel
   * file's connector and `slack/<slug>`, the names a connector made for this
   * agent would carry. No other unattached connector is ever reused.
   */
  namedUids: ReadonlySet<string>;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<SlackConnectorInspection> {
  const { deps, projectRoot, projectId, orgId, onOutput, signal } = input;
  const list = await listProjectSlackConnectors(input);
  if (list.state === "failed") return list;
  const listedUids = new Set(list.connectors.map((connector) => connector.uid));
  const unlisted = [...input.namedUids].filter((uid) => !listedUids.has(uid));
  const lookupInput = { deps, projectRoot, orgId, onOutput, signal };

  const inspectListed = async (
    connector: RawSlackConnector,
  ): Promise<SlackConnectorCandidate | string> => {
    const details = await fetchSlackConnectorDetails({
      ...lookupInput,
      connectorId: connector.id,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    });
    if (details.state === "failed") return `${connector.uid}: ${details.message}`;
    return toCandidate({
      details: details.details,
      attached: true,
      projects: connector.projects,
      projectId,
      createdAt: connector.createdAt,
    });
  };
  const inspectNamed = async (
    uid: string,
  ): Promise<SlackConnectorCandidate | string | undefined> => {
    const lookup = await lookupSlackConnector({
      ...lookupInput,
      key: uid,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    });
    if (lookup.state === "absent") return undefined;
    if (lookup.state === "failed") return `${uid}: ${lookup.message}`;
    const projects = await fetchConnectorProjects({
      ...lookupInput,
      connectorId: lookup.details.ref.id,
    });
    if (projects.state === "failed") return `${uid}: ${projects.message}`;
    return toCandidate({
      details: lookup.details,
      // The project-scoped list is authoritative; this only absorbs a lagging list.
      attached: projects.projects.some((project) => project.id === projectId),
      projects: projects.projects,
      projectId,
      createdAt: 0,
    });
  };
  const inspected = await mapWithConcurrency(
    [
      ...list.connectors.map((connector) => () => inspectListed(connector)),
      ...unlisted.map((uid) => () => inspectNamed(uid)),
    ],
    INSPECTION_CONCURRENCY,
    (inspect) => inspect(),
  );
  const failure = inspected.find((entry) => typeof entry === "string");
  if (failure !== undefined) return { state: "failed", message: failure };
  const candidates = inspected.filter((entry) => typeof entry === "object");
  return { state: "ok", candidates };
}

/** Rechecks the chosen connector before changing its project access or destinations. */
export async function refreshSlackCandidate(input: {
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  candidate: SlackConnectorCandidate;
  projectId: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<{ state: "ok"; candidate: SlackConnectorCandidate } | LookupFailure> {
  const { deps, projectRoot, candidate, projectId, orgId, onOutput, signal } = input;
  const details = await fetchSlackConnectorDetails({
    deps,
    projectRoot,
    connectorId: candidate.id,
    orgId,
    onOutput,
    timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    signal,
  });
  if (details.state === "failed") return details;
  if (details.details.ref.uid !== candidate.uid) {
    return { state: "failed", message: `The connector ${candidate.uid} changed since inspection.` };
  }
  const projects = await fetchConnectorProjects({
    deps,
    projectRoot,
    connectorId: candidate.id,
    orgId,
    onOutput,
    signal,
  });
  if (projects.state === "failed") return projects;
  return {
    state: "ok",
    candidate: toCandidate({
      details: details.details,
      attached: projects.projects.some((project) => project.id === projectId),
      projects: projects.projects,
      projectId,
      createdAt: candidate.createdAt,
    }),
  };
}

/** Name probes stop here so a long run of taken names fails with a clear error. */
const MAX_CONNECTOR_NAME_PROBES = 20;

/**
 * Picks the `--name` for a new connector: `slug`, then `slug-2`, `slug-3`,
 * and so on. Connect derives the UID `slack/<name>` from it, and a UID a
 * team connector already uses fails the create, so each name is checked by
 * looking its UID up directly.
 */
export async function findFreeSlackConnectorName(input: {
  deps: Pick<SlackConnectLifecycleDeps, "captureVercel">;
  projectRoot: string;
  orgId: string | undefined;
  slug: string;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<{ state: "ok"; name: string } | LookupFailure> {
  for (let index = 1; index <= MAX_CONNECTOR_NAME_PROBES; index += 1) {
    const name = index === 1 ? input.slug : `${input.slug}-${index}`;
    const uid = `slack/${name}`;
    const lookup = await lookupSlackConnector({
      ...input,
      key: uid,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    });
    if (lookup.state === "failed") return lookup;
    if (lookup.state === "absent") return { state: "ok", name };
  }
  return {
    state: "failed",
    message: `Slack connectors \`slack/${input.slug}\` through \`slack/${input.slug}-${MAX_CONNECTOR_NAME_PROBES}\` already exist. Remove unused ones with \`vercel connect remove <uid> --disconnect-all --yes\`, then try again.`,
  };
}

/** Result of making a connector deliver this project's events to eve's Slack route. */
export type SlackRoutingResult =
  | { state: "configured" }
  | { state: "attach-failed"; message?: string };

/**
 * Applies the planned routing mutation. Never detaches: attach only adds
 * token access, and the trigger-destinations replacement keeps the project's
 * token access and every other project's entries intact.
 */
export async function applySlackRouting(input: {
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  ref: SlackConnectorRef;
  plan: Extract<SlackRoutingPlan, { kind: "apply" }>;
  orgId: string | undefined;
  onOutput: CommandOutput;
  signal?: AbortSignal;
}): Promise<SlackRoutingResult> {
  const { deps, projectRoot, ref, plan, orgId, onOutput, signal } = input;
  if (plan.attach) {
    const args = ["connect", "attach", ref.uid, "--yes"];
    if (orgId !== undefined) args.push("--scope", orgId);
    const attached = await deps.runVercel(args, {
      cwd: projectRoot,
      onOutput,
      nonInteractive: true,
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
      signal,
    });
    if (!attached) return { state: "attach-failed" };
  }
  if (plan.destinations === undefined) return { state: "configured" };
  const args = connectApiArgs(`${connectorPath(ref.id)}/trigger-destinations`, orgId, {}, [
    "--method",
    "PATCH",
    "--input",
    "-",
  ]);
  const result = normalizeVercelApiResult(
    await deps.captureVercel(args, {
      cwd: projectRoot,
      onOutput,
      stdin: JSON.stringify({ destinations: plan.destinations }),
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
      signal,
    }),
  );
  return result.ok
    ? { state: "configured" }
    : { state: "attach-failed", message: result.failure.message };
}

type SlackWorkspaceLookup =
  | { state: "connected"; workspace: SlackWorkspaceConnection }
  | { state: "pending" }
  | { state: "failed"; message: string };

type SlackConnectorDetailsLookup =
  | { state: "found"; details: SlackConnectorDetails }
  | { state: "failed"; message: string };

/**
 * Looks one connector up by ID or UID. Connect answers 404 for a key no team
 * connector uses, which is how a UID is proven free.
 */
async function lookupSlackConnector(input: {
  deps: Pick<SlackConnectLifecycleDeps, "captureVercel">;
  projectRoot: string;
  key: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SlackConnectorDetailsLookup | { state: "absent"; message: string }> {
  const result = await input.deps.captureVercel(
    connectApiArgs(connectorPath(input.key), input.orgId),
    {
      cwd: input.projectRoot,
      onOutput: input.onOutput,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    },
  );
  if (!result.ok) {
    return {
      state: isNotFoundApiFailure(result.failure) ? "absent" : "failed",
      message: result.failure.message,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const details = parseSlackConnectorDetails(parsed);
    return details?.ref.id === input.key || details?.ref.uid === input.key
      ? { state: "found", details }
      : { state: "failed", message: "Vercel returned an invalid Slack connector." };
  } catch {
    return { state: "failed", message: "Vercel returned invalid JSON for the Slack connector." };
  }
}

/** Fetches and validates one team-scoped connector detail payload. */
export async function fetchSlackConnectorDetails(input: {
  deps: Pick<SlackConnectLifecycleDeps, "captureVercel">;
  projectRoot: string;
  connectorId: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SlackConnectorDetailsLookup> {
  const lookup = await lookupSlackConnector({ ...input, key: input.connectorId });
  return lookup.state === "absent" ? { state: "failed", message: lookup.message } : lookup;
}

/** Fetches the Slack workspace connected to a connector, if one exists yet. */
export async function fetchSlackWorkspace(input: {
  deps: Pick<SlackConnectLifecycleDeps, "captureVercel">;
  projectRoot: string;
  connectorId: string;
  orgId: string | undefined;
  onOutput: CommandOutput;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SlackWorkspaceLookup> {
  const lookup = await fetchSlackConnectorDetails(input);
  if (lookup.state === "failed") return lookup;
  return lookup.details.workspace === undefined
    ? { state: "pending" }
    : { state: "connected", workspace: lookup.details.workspace };
}

async function cleanupConnectorUid(
  context: SlackConnectorCleanupContext,
  uid: string,
): Promise<boolean> {
  const { log, deps, projectRoot, onOutput } = context;
  const removed = await deps.runVercel(["connect", "remove", uid, "--disconnect-all", "--yes"], {
    cwd: projectRoot,
    onOutput,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
  });
  if (removed) return true;

  // A failed `connect remove` fails closed: a single inventory read that omits
  // the connector is not proof of removal under eventual consistency, so the
  // caller must surface it rather than assume it is gone.
  log.warning(
    `Could not remove the abandoned Slack connector. Run \`vercel connect remove ${uid} --disconnect-all --yes\` to clean it up.`,
  );
  return false;
}

async function cleanupConnectorUids(
  context: SlackConnectorCleanupContext,
  connectorUids: readonly string[],
): Promise<SlackConnectorCleanupResult> {
  const failed: string[] = [];
  for (const uid of new Set(connectorUids)) {
    if (!(await cleanupConnectorUid(context, uid))) failed.push(uid);
  }
  return failed.length === 0 ? { state: "clean" } : { state: "failed", connectorUids: failed };
}

/**
 * Removes the exact connector returned by `connect create`. A run the CLI
 * rejected before its browser flow cannot have created a connector, so there
 * is nothing to remove. Otherwise, when no UID was returned, ownership cannot be
 * proven: the browser page may still create one, and a concurrent or
 * eventually-consistent connector looks the same as this attempt's. So
 * cleanup fails closed. It removes nothing and instead surfaces
 * `expectedUid`, which was free before this attempt, if it now exists, so the
 * caller can stop rather than risk removing a bystander's connector.
 */
export async function cleanupCreatedAttempt(
  context: SlackConnectorCleanupContext,
  input: {
    expectedUid: string;
    createdRef: SlackConnectorRef | undefined;
    /** The CLI reported its own error before printing the browser URL. */
    rejected: boolean;
  },
): Promise<SlackConnectorCleanupResult> {
  if (input.createdRef) {
    return cleanupConnectorUids(context, [input.createdRef.uid]);
  }
  if (input.rejected) return { state: "clean" };

  context.log.warning(
    "eve couldn't confirm the Slack request in your browser was cancelled. Wait for it to expire before retrying.",
  );
  const lookup = await lookupSlackConnector({
    ...context,
    key: input.expectedUid,
    timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
  });
  return {
    state: "failed",
    connectorUids: lookup.state === "found" ? [input.expectedUid] : [],
  };
}
