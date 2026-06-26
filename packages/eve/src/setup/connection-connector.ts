import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import type { Prompter } from "#setup/prompter.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

/** Controls connector selection while adding a Connect-backed connection. */
export interface SetupConnectionConnectorOptions {
  log: ChannelSetupLog;
  prompter: Prompter;
  projectRoot: string;
  slug: string;
  service: string;
  canonicalConnectorName: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
}

/** Connector identity returned by the Vercel CLI. */
export interface ConnectConnectorRef {
  uid: string;
  id: string;
  name?: string;
}

export type SetupConnectionConnectorResult =
  | { kind: "existing"; connectorUid: string }
  | { kind: "created"; connectorUid: string; connectorId: string };

type ConnectorResolution =
  | { kind: "existing"; connector: ConnectConnectorRef }
  | { kind: "created"; connector: ConnectConnectorRef };

const CREATED_CONNECTOR = /\bConnector created:\s*(scl_[A-Za-z0-9_-]+)\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function parseConnectorRef(value: unknown): ConnectConnectorRef | undefined {
  if (!isRecord(value) || typeof value["uid"] !== "string" || typeof value["id"] !== "string") {
    return undefined;
  }
  const connector: ConnectConnectorRef = { uid: value["uid"], id: value["id"] };
  if (typeof value["name"] === "string") connector.name = value["name"];
  return connector;
}

/** Parses a created connector that can issue user credentials. */
export function parseCreatedConnector(stdout: string): ConnectConnectorRef | undefined {
  const value = parseJson(stdout);
  const connector = parseConnectorRef(value);
  if (!isRecord(value) || connector === undefined) return undefined;
  const subjects = value["supportedSubjectTypes"];
  return Array.isArray(subjects) && subjects.includes("user") ? connector : undefined;
}

function parseConnectorList(
  candidates: readonly unknown[],
  service: string,
): ConnectConnectorRef[] {
  const connectors: ConnectConnectorRef[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate["service"] === "string" && candidate["service"] !== service) continue;
    const connector = parseConnectorRef(candidate);
    if (connector !== undefined) connectors.push(connector);
  }
  return connectors;
}

function parseConnectorListPage(
  value: unknown,
  service: string,
): { connectors: ConnectConnectorRef[]; cursor?: string } | undefined {
  if (!isRecord(value) || !Array.isArray(value["connectors"])) return undefined;
  const cursor = typeof value["cursor"] === "string" ? value["cursor"] : undefined;
  return cursor === undefined
    ? { connectors: parseConnectorList(value["connectors"], service) }
    : { connectors: parseConnectorList(value["connectors"], service), cursor };
}

async function listConnectors(
  options: SetupConnectionConnectorOptions,
  project: VercelProjectReference,
  onOutput: ProcessOutputHandler,
): Promise<ConnectConnectorRef[]> {
  const connectors: ConnectConnectorRef[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const args = [
      "connect",
      "list",
      "-F",
      "json",
      "--all-projects",
      "--service",
      options.service,
      "--scope",
      project.orgId,
    ];
    if (cursor !== undefined) args.push("--next", cursor);
    const result = await captureVercel(args, {
      cwd: options.projectRoot,
      onOutput,
      signal: options.signal,
    });
    if (!result.ok) throw new Error(result.failure.message);
    const page = parseJson(result.stdout);
    const parsed = parseConnectorListPage(page, options.service);
    if (parsed === undefined) {
      throw new Error(`Vercel returned an invalid connector list for ${options.service}.`);
    }
    connectors.push(...parsed.connectors);
    const next = parsed.cursor;
    if (next !== undefined && seenCursors.has(next)) {
      throw new Error(`The connector list repeated cursor ${next}.`);
    }
    if (next !== undefined) seenCursors.add(next);
    cursor = next;
  } while (cursor !== undefined);
  return connectors;
}

async function supportsUserAuthorization(
  options: SetupConnectionConnectorOptions,
  project: VercelProjectReference,
  connector: ConnectConnectorRef,
  onOutput: ProcessOutputHandler,
): Promise<boolean> {
  const endpoint = `/v1/connect/connectors/${encodeURIComponent(connector.id)}`;
  const result = await captureVercel(["api", endpoint, "--scope", project.orgId, "--raw"], {
    cwd: options.projectRoot,
    onOutput,
    signal: options.signal,
  });
  if (!result.ok) throw new Error(`Could not verify connector ${connector.uid}.`);
  const value = parseJson(result.stdout);
  if (
    !isRecord(value) ||
    value["id"] !== connector.id ||
    value["uid"] !== connector.uid ||
    (typeof value["service"] === "string" && value["service"] !== options.service)
  ) {
    throw new Error(`Vercel returned invalid details for connector ${connector.uid}.`);
  }
  const subjects = value["supportedSubjectTypes"];
  return Array.isArray(subjects) && subjects.includes("user");
}

function connectorNames(connectors: readonly ConnectConnectorRef[]): Set<string> {
  const names = new Set<string>();
  for (const connector of connectors) {
    if (connector.name !== undefined) names.add(connector.name.toLowerCase());
    const uidName = connector.uid.slice(connector.uid.lastIndexOf("/") + 1).trim();
    if (uidName.length > 0) names.add(uidName.toLowerCase());
  }
  return names;
}

function connectorMatchesCanonicalName(connector: ConnectConnectorRef, name: string): boolean {
  const canonical = name.toLowerCase();
  if (connector.name?.toLowerCase() === canonical) return true;
  const uidName = connector.uid.slice(connector.uid.lastIndexOf("/") + 1).trim();
  return uidName.toLowerCase() === canonical;
}

function nextConnectorName(slug: string, names: ReadonlySet<string>): string {
  if (!names.has(slug.toLowerCase())) return slug;
  let suffix = 2;
  while (names.has(`${slug}-${suffix}`.toLowerCase())) suffix += 1;
  return `${slug}-${suffix}`;
}

/** Removes a connector created by this setup attempt. */
export async function cleanupCreatedConnectionConnector(input: {
  log: ChannelSetupLog;
  projectRoot: string;
  connectorId: string;
  /** The linked Vercel owner; inferred from the project link when omitted. */
  orgId?: string;
}): Promise<void> {
  const orgId = input.orgId ?? (await readProjectLink(input.projectRoot))?.orgId;
  const args = ["connect", "remove", input.connectorId, "--disconnect-all", "--yes"];
  if (orgId !== undefined) args.push("--scope", orgId);
  const removed = await runVercel(args, {
    cwd: input.projectRoot,
    onOutput: createPromptCommandOutput(input.log),
  });
  if (!removed) {
    throw new Error(
      `Could not remove connector ${input.connectorId}; run \`vercel connect remove ${input.connectorId} --disconnect-all --yes\`.`,
    );
  }
}

async function attach(
  options: SetupConnectionConnectorOptions,
  project: VercelProjectReference,
  connectorUid: string,
  onOutput: ProcessOutputHandler,
): Promise<boolean> {
  return runVercel(["connect", "attach", connectorUid, "--yes", "--scope", project.orgId], {
    cwd: options.projectRoot,
    onOutput,
    signal: options.signal,
  });
}

async function resolveFallbackConnector(
  options: SetupConnectionConnectorOptions,
  project: VercelProjectReference,
  onOutput: ProcessOutputHandler,
  connectors: readonly ConnectConnectorRef[],
  initialNotice: string,
): Promise<ConnectorResolution> {
  let notice = initialNotice;
  while (true) {
    const choice = await options.prompter.select<"find" | "create">({
      message: `Which connector should ${options.slug} use?`,
      hintLayout: "inline",
      notices: [{ tone: "warning", text: notice }],
      options: [
        { value: "find", label: "Find a new one", hint: "Browse existing connectors" },
        { value: "create", label: "Create a new one", hint: "Register another connector" },
      ],
    });
    if (choice === "find") {
      const supported: ConnectConnectorRef[] = [];
      for (const connector of connectors) {
        if (await supportsUserAuthorization(options, project, connector, onOutput)) {
          supported.push(connector);
        }
      }
      if (supported.length === 0) {
        notice = `No existing ${options.service} connectors support user authorization.`;
        continue;
      }
      const byUid = new Map(supported.map((connector) => [connector.uid, connector]));
      const uid = await options.prompter.select<string>({
        message: `Select a connector for ${options.slug}`,
        hintLayout: "inline",
        search: true,
        placeholder: "type to search connectors",
        options: supported.map((connector) => ({
          value: connector.uid,
          label: connector.uid,
          hint: connector.name ?? connector.id,
        })),
      });
      const connector = byUid.get(uid);
      if (connector === undefined) throw new Error(`Connector ${uid} is no longer available.`);
      return { kind: "existing", connector };
    }

    const names = connectorNames(connectors);
    const name = (
      await options.prompter.text({
        message: "New connector name",
        defaultValue: nextConnectorName(options.slug, names),
        validate: (value) => {
          const normalized = value.trim().toLowerCase();
          if (normalized.length === 0) return "A name is required.";
          return names.has(normalized) ? "A connector with this name already exists." : undefined;
        },
      })
    ).trim();
    const transcript: string[] = [];
    const createOutput: ProcessOutputHandler = (line) => {
      transcript.push(line.text);
      onOutput(line);
    };
    const created = await withPhase(
      options.log,
      "Waiting for you to complete setup in the browser…",
      () =>
        runVercelCaptureStdout(
          [
            "connect",
            "create",
            options.service,
            "--name",
            name,
            "-F",
            "json",
            "--scope",
            project.orgId,
          ],
          { cwd: options.projectRoot, onOutput: createOutput, signal: options.signal },
        ),
      { kind: "external-action", emphasis: "browser" },
    );
    const raw = parseConnectorRef(parseJson(created.stdout));
    const ownedId = raw?.id ?? CREATED_CONNECTOR.exec(transcript.join("\n"))?.[1];
    const connector = created.ok ? parseCreatedConnector(created.stdout) : undefined;
    if (connector !== undefined) return { kind: "created", connector };
    const message = created.ok
      ? `The ${options.service} connector does not support user authorization.`
      : `Could not create the ${options.service} connector.`;
    if (ownedId !== undefined) {
      try {
        await cleanupCreatedConnectionConnector({
          log: options.log,
          projectRoot: options.projectRoot,
          connectorId: ownedId,
          orgId: project.orgId,
        });
      } catch (error) {
        const cleanup = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} ${cleanup}`);
      }
      options.signal?.throwIfAborted();
    }
    throw new Error(message);
  }
}

/** Attaches the canonical connector by name first, then offers explicit Find/Create fallbacks. */
export async function setupConnectionConnector(
  options: SetupConnectionConnectorOptions,
): Promise<SetupConnectionConnectorResult> {
  const onOutput = createPromptCommandOutput(options.log);
  const project = options.project;
  const connectors = await listConnectors(options, project, onOutput);
  const canonical = connectors.find((connector) =>
    connectorMatchesCanonicalName(connector, options.canonicalConnectorName),
  );
  let notice = `Could not find a connector named ${options.canonicalConnectorName}.`;

  if (canonical !== undefined) {
    if (await supportsUserAuthorization(options, project, canonical, onOutput)) {
      if (await attach(options, project, canonical.uid, onOutput)) {
        options.log.success(`Attached ${canonical.uid} connector`);
        return { kind: "existing", connectorUid: canonical.uid };
      }
      options.signal?.throwIfAborted();
      notice = `Could not attach ${canonical.uid}.`;
    } else {
      notice = `${canonical.uid} does not support user authorization.`;
    }
  }

  const resolution = await resolveFallbackConnector(options, project, onOutput, connectors, notice);
  if (!(await attach(options, project, resolution.connector.uid, onOutput))) {
    if (resolution.kind === "created") {
      const message = `Could not attach ${resolution.connector.uid} to the linked project.`;
      try {
        await cleanupCreatedConnectionConnector({
          log: options.log,
          projectRoot: options.projectRoot,
          connectorId: resolution.connector.id,
          orgId: project.orgId,
        });
      } catch (error) {
        const cleanup = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} ${cleanup}`);
      }
      options.signal?.throwIfAborted();
      throw new Error(message);
    }
    throw new Error(`Could not attach ${resolution.connector.uid} to the linked project.`);
  }
  options.log.success(`Attached ${resolution.connector.uid} connector`);
  return resolution.kind === "created"
    ? {
        kind: "created",
        connectorUid: resolution.connector.uid,
        connectorId: resolution.connector.id,
      }
    : { kind: "existing", connectorUid: resolution.connector.uid };
}
