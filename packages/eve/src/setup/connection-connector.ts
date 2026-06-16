import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createPromptCommandOutput, type ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { updateConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";

/** Controls connector provisioning while adding a Connect-backed connection. */
export interface SetupConnectionConnectorOptions {
  /** Status and command output stream through this log (rail styling preserved). */
  log: ChannelSetupLog;
  projectRoot: string;
  /** Connection slug; also the connector `--name`. */
  slug: string;
  /** `vercel connect create <service>` identifier (e.g. `mcp.linear.app`). */
  service: string;
  /** Generated `agent/connections/<slug>.ts` whose `connect("…")` is patched. */
  connectionFilePath: string;
  /**
   * Links a Vercel project before Connect provisioning when the caller owns a
   * richer linking flow (e.g. shared team selection). Returns the linked
   * project id, or `undefined` when linking did not complete. When omitted,
   * falls back to a bare `vercel link`.
   */
  linkProject?: () => Promise<string | undefined>;
}

/** Outcome of the Connect create-and-patch sequence for a connection. */
export type SetupConnectionConnectorResult =
  | { kind: "create-failed"; created: false }
  | { kind: "connector-unresolved"; created: true }
  | { kind: "patch-failed"; created: true; connectorUid: string }
  | { kind: "patched"; created: true; connectorUid: string };

interface VercelConnectListClient {
  uid?: unknown;
  id?: unknown;
  type?: unknown;
  service?: unknown;
  createdAt?: unknown;
  projects?: unknown;
}

interface VercelConnectListResponse {
  /** `vercel connect list -F json` (current CLI). */
  connectors?: unknown;
  /** Older CLI builds emitted the same array under `clients`. */
  clients?: unknown;
}

/** Identifiers returned by Vercel Connect for an OAuth connector. */
export interface ConnectConnectorRef {
  uid: string;
  id: string;
}

/**
 * Reads the connector identifiers from `vercel connect create … -F json`
 * stdout. This is the authoritative source for the just-created connector's
 * UID — it avoids a follow-up `connect list`, which can momentarily 404/rate
 * limit right after creation and cannot disambiguate when a service already
 * has multiple connectors. Returns `undefined` when stdout is empty or not the
 * expected JSON (e.g. an older CLI without `-F json` support on `create`).
 */
export function parseCreatedConnector(stdout: string): ConnectConnectorRef | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { uid, id } = parsed as { uid?: unknown; id?: unknown };
  if (typeof uid !== "string" || typeof id !== "string") return undefined;
  return { uid, id };
}

function attachedToProject(raw: VercelConnectListClient, projectId: string | undefined): boolean {
  if (projectId === undefined) return false;
  if (!Array.isArray(raw.projects)) return false;
  return raw.projects.some(
    (project) =>
      typeof project === "object" &&
      project !== null &&
      (project as { id?: unknown }).id === projectId,
  );
}

/**
 * Finds the connector to wire into the generated connection. The list is
 * expected to be scoped to the requested service server-side (via
 * `--service`), since `vercel connect list -F json` does not include a
 * `service` field per connector. Prefers, in order: the connector already
 * attached to this project, then the newest connector. When Connect does
 * report a `service` field, mismatches are still skipped defensively.
 */
export function pickConnectConnector(
  listJson: unknown,
  service: string,
  projectId: string | undefined,
): ConnectConnectorRef | undefined {
  if (typeof listJson !== "object" || listJson === null) return undefined;
  const response = listJson as VercelConnectListResponse;
  const connectors = response.connectors ?? response.clients;
  if (!Array.isArray(connectors)) return undefined;

  let attached: { ref: ConnectConnectorRef; createdAt: number } | undefined;
  let newest: { ref: ConnectConnectorRef; createdAt: number } | undefined;

  for (const raw of connectors as VercelConnectListClient[]) {
    if (typeof raw.service === "string" && raw.service !== service) continue;
    if (typeof raw.uid !== "string" || typeof raw.id !== "string") continue;

    const ref: ConnectConnectorRef = { uid: raw.uid, id: raw.id };
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;

    if (!newest || createdAt > newest.createdAt) {
      newest = { ref, createdAt };
    }
    if (attachedToProject(raw, projectId) && (!attached || createdAt > attached.createdAt)) {
      attached = { ref, createdAt };
    }
  }

  return (attached ?? newest)?.ref;
}

async function readProjectId(projectRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(projectRoot, ".vercel", "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return typeof parsed.projectId === "string" ? parsed.projectId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connect attach requires a linked Vercel project. The connection step can run
 * before one exists — the gateway step used an API key or a local provider, or
 * `eve connections add` ran in a fresh checkout — so link one first. Returns the
 * resolved project id, or `undefined` when linking did not complete.
 */
async function ensureLinkedProject(
  log: ChannelSetupLog,
  projectRoot: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
): Promise<string | undefined> {
  const existing = await readProjectId(projectRoot);
  if (existing) return existing;
  log.message("Linking a Vercel project for Connect...");
  await runVercel(["link"], { cwd: projectRoot, onOutput });
  return readProjectId(projectRoot);
}

async function findConnector(
  projectRoot: string,
  service: string,
  projectId: string | undefined,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
): Promise<ConnectConnectorRef | undefined> {
  const result = await captureVercel(
    ["connect", "list", "-F", "json", "--all-projects", "--service", service],
    {
      cwd: projectRoot,
      onOutput,
    },
  );
  if (!result.ok) return undefined;
  try {
    return pickConnectConnector(JSON.parse(result.stdout), service, projectId);
  } catch {
    return undefined;
  }
}

/**
 * Creates a Vercel Connect OAuth connector for a connection and rewrites the
 * generated `connect("…")` call to the connector UID Connect assigns. The
 * `vercel connect create` step is interactive (it opens a browser to complete
 * the OAuth grant); callers should only invoke this from an interactive flow.
 */
export async function setupConnectionConnector(
  options: SetupConnectionConnectorOptions,
): Promise<SetupConnectionConnectorResult> {
  const { log, projectRoot, slug, service, connectionFilePath } = options;
  const onOutput = createPromptCommandOutput(log);

  const projectId = options.linkProject
    ? await options.linkProject()
    : await ensureLinkedProject(log, projectRoot, onOutput);

  log.message(`Connecting ${slug} via Vercel Connect...`);
  const create = await runVercelCaptureStdout(
    ["connect", "create", service, "--name", slug, "-F", "json"],
    { cwd: projectRoot, onOutput },
  );
  if (!create.ok) {
    log.warning(
      `Could not create the connector. Run \`vercel connect create ${service} --name ${slug}\`, then set the UID in agent/connections/${slug}.ts.`,
    );
    return { kind: "create-failed", created: false };
  }

  // Authoritative path: the just-created connector's UID is on `create` stdout.
  // Fall back to a service-scoped `connect list` only when the CLI emits no
  // parseable JSON (e.g. an older build without `-F json` on `create`).
  let ref = parseCreatedConnector(create.stdout);
  if (!ref) {
    // The `Connecting ...` status stays active so this fallback lookup reads
    // as part of the same step rather than a separate line.
    ref = await findConnector(projectRoot, service, projectId, onOutput);
  }
  if (!ref) {
    log.warning(
      `Could not locate the connector. Run \`vercel connect list --all-projects\` to find its UID, then set it in agent/connections/${slug}.ts.`,
    );
    return { kind: "connector-unresolved", created: true };
  }

  // Attach the connector to the linked project so the agent can call it from
  // its builds and runtime. `vercel connect create` only creates the connector;
  // without this attach it shows "No projects connected yet" in the dashboard.
  if (!projectId) {
    log.warning(
      `Created connector ${ref.uid} but no Vercel project is linked, so it isn't attached. Run \`vercel link\`, then \`vercel connect attach ${ref.uid} --yes\`.`,
    );
  } else {
    const attached = await runVercel(["connect", "attach", ref.uid, "--yes"], {
      cwd: projectRoot,
      onOutput,
    });
    if (!attached) {
      log.warning(
        `Created connector ${ref.uid} but could not attach it to this project. Run \`vercel connect attach ${ref.uid} --yes\`.`,
      );
    }
  }

  const { patched } = await updateConnectionConnectorUid(connectionFilePath, ref.uid);
  if (!patched) {
    log.warning(
      `Created connector ${ref.uid}. Update \`connect("…")\` in agent/connections/${slug}.ts to "${ref.uid}".`,
    );
    return { kind: "patch-failed", created: true, connectorUid: ref.uid };
  }

  log.success(`Linked ${slug} to ${ref.uid}`);
  return { kind: "patched", created: true, connectorUid: ref.uid };
}
