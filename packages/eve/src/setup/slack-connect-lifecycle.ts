import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#setup/scaffold/index.js";
import { createPromptCommandOutput, type ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

import {
  parseSlackConnectorDetails,
  parseSlackConnectors,
  pickSlackConnector,
  type RawSlackConnector,
  type SlackConnectorDetails,
  type SlackConnectorRef,
  type SlackWorkspaceConnection,
  type VercelConnectListResponse,
} from "./slack-connect.js";

export const CONNECT_LOOKUP_TIMEOUT_MS = 60_000;
export const CONNECT_MUTATION_TIMEOUT_MS = 2 * 60_000;

const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
});

/** Connect subprocess operations needed to inventory and remove Slack connectors. */
export interface SlackConnectLifecycleDeps {
  captureVercel: typeof captureVercel;
  runVercel: typeof runVercel;
}

export type SlackConnectorInventory =
  | { state: "ok"; body: unknown; connectors: readonly RawSlackConnector[] }
  | { state: "failed"; message: string };

export type SlackConnectorCleanupResult =
  | { state: "clean" }
  | { state: "failed"; connectorUids: readonly string[] };

type CommandOutput = ReturnType<typeof createPromptCommandOutput>;

/** Shared dependencies and output routing for one connector cleanup operation. */
export interface SlackConnectorCleanupContext {
  log: ChannelSetupLog;
  deps: SlackConnectLifecycleDeps;
  projectRoot: string;
  onOutput: CommandOutput;
}

/** Reads and validates the account-level Slack connector inventory. */
export async function listSlackConnectors(
  deps: SlackConnectLifecycleDeps,
  projectRoot: string,
  onOutput: CommandOutput,
  signal?: AbortSignal,
): Promise<SlackConnectorInventory> {
  const result = await deps.captureVercel(["connect", "list", "-F", "json", "--all-projects"], {
    cwd: projectRoot,
    onOutput,
    timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    signal,
  });
  if (!result.ok) return { state: "failed", message: result.failure.message };

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { state: "failed", message: "Vercel returned a malformed connector list." };
    }
    const response = parsed as VercelConnectListResponse;
    if (!Array.isArray(response.connectors ?? response.clients)) {
      return { state: "failed", message: "Vercel returned a malformed connector list." };
    }
    return { state: "ok", body: parsed, connectors: parseSlackConnectors(parsed) };
  } catch {
    return { state: "failed", message: "Vercel returned invalid JSON for the connector list." };
  }
}

/** Project and team identifiers from a valid on-disk Vercel link. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

/** Reads the linked Vercel project and team ids from `.vercel/project.json`. */
export async function readProjectLink(projectRoot: string): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectRoot, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type SlackConnectorLookup =
  | { state: "found"; connector: SlackConnectorRef; connectorUids: ReadonlySet<string> }
  | { state: "not-found"; connectorUids: ReadonlySet<string> }
  | { state: "failed"; message: string };

/** Resolves the expected (or newest project-attached) Slack connector from the inventory. */
export async function findSlackConnector(
  deps: SlackConnectLifecycleDeps,
  projectRoot: string,
  projectId: string | undefined,
  expectedUid: string | undefined,
  onOutput: CommandOutput,
  signal?: AbortSignal,
): Promise<SlackConnectorLookup> {
  const list = await listSlackConnectors(deps, projectRoot, onOutput, signal);
  if (list.state === "failed") return list;
  const connectorUids = new Set(list.connectors.map((connector) => connector.uid));
  const connector = pickSlackConnector(list.body, projectId, expectedUid);
  return connector === undefined
    ? { state: "not-found", connectorUids }
    : { state: "found", connector, connectorUids };
}

/**
 * Outcome of pointing a connector's trigger destination at this project's eve
 * route. Detach and attach are reported separately because attach must not run
 * while an old trigger destination may still exist. A `detach-failed` connector
 * is left in a known-stale state the caller surfaces with manual recovery steps.
 */
export type SlackConnectorAttachmentResult =
  | { state: "attached" }
  | { state: "detach-failed" }
  | { state: "attach-failed" };

/**
 * Replaces the connector's default trigger destination with the eve route:
 * detach the existing destination first, then attach this project. Either
 * subprocess failing short-circuits so a half-configured connector is reported
 * rather than silently left pointing at the wrong place.
 */
export async function attachSlackConnector(
  deps: SlackConnectLifecycleDeps,
  projectRoot: string,
  ref: SlackConnectorRef,
  onOutput: CommandOutput,
  signal?: AbortSignal,
): Promise<SlackConnectorAttachmentResult> {
  const detached = await deps.runVercel(["connect", "detach", ref.uid, "--yes"], {
    cwd: projectRoot,
    onOutput,
    nonInteractive: true,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    signal,
  });
  if (!detached) return { state: "detach-failed" };
  const attached = await deps.runVercel(
    [
      "connect",
      "attach",
      ref.uid,
      "--triggers",
      "--trigger-path",
      SLACK_CHANNEL_DEFAULT_ROUTE,
      "--yes",
    ],
    {
      cwd: projectRoot,
      onOutput,
      nonInteractive: true,
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
      signal,
    },
  );
  return attached ? { state: "attached" } : { state: "attach-failed" };
}

export type SlackWorkspaceLookup =
  | { state: "connected"; workspace: SlackWorkspaceConnection }
  | { state: "pending" }
  | { state: "failed"; message: string };

export type SlackConnectorDetailsLookup =
  | { state: "found"; details: SlackConnectorDetails }
  | { state: "failed"; message: string };

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
  const suffix = input.orgId === undefined ? "" : `?teamId=${encodeURIComponent(input.orgId)}`;
  const args = ["api", `/v1/connect/connectors/${encodeURIComponent(input.connectorId)}${suffix}`];
  if (input.orgId !== undefined) args.push("--scope", input.orgId);
  const result = await input.deps.captureVercel(args, {
    cwd: input.projectRoot,
    onOutput: input.onOutput,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!result.ok) return { state: "failed", message: result.failure.message };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const details = parseSlackConnectorDetails(parsed);
    return details?.ref.id === input.connectorId
      ? { state: "found", details }
      : { state: "failed", message: "Vercel returned an invalid Slack connector." };
  } catch {
    return { state: "failed", message: "Vercel returned invalid JSON for the Slack connector." };
  }
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
 * Removes the exact connector returned by `connect create`. When no UID was
 * returned, ownership cannot be proven: a concurrent or eventually-consistent
 * connector looks the same as this attempt's. So cleanup fails closed. It
 * removes nothing and instead surfaces the connectors that look like this
 * attempt's, matching `expectedUid` and absent from the pre-create snapshot, so
 * the caller can stop rather than risk removing a bystander's connector.
 */
export async function cleanupCreatedAttempt(
  context: SlackConnectorCleanupContext,
  input: {
    expectedUid: string;
    baselineConnectorUids: ReadonlySet<string>;
    createdRef: SlackConnectorRef | undefined;
  },
): Promise<SlackConnectorCleanupResult> {
  if (input.createdRef) {
    return cleanupConnectorUids(context, [input.createdRef.uid]);
  }

  context.log.warning(
    "Vercel returned no connector UID for the abandoned Slack Connect request, so eve cannot prove that request was cancelled. No connector was removed; do not retry until the browser request is no longer usable.",
  );
  const inventory = await listSlackConnectors(context.deps, context.projectRoot, context.onOutput);
  if (inventory.state === "failed") return { state: "failed", connectorUids: [] };

  const suspected = inventory.connectors
    .map((connector) => connector.uid)
    .filter(
      (uid) =>
        (uid === input.expectedUid || uid.startsWith(`${input.expectedUid}-`)) &&
        !input.baselineConnectorUids.has(uid),
    );
  return { state: "failed", connectorUids: suspected };
}
