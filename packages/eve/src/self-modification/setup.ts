import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { discoverAgent } from "#discover/discover-agent.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import {
  captureVercel,
  runVercelCaptureStdout,
  type VercelCaptureResult,
} from "#setup/primitives/run-vercel.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";

import {
  isBranchName,
  isGitHubOwner,
  isGitHubRepositoryName,
  isRepositoryRelativeDirectory,
} from "./remote/config-schema.js";
import { renderLocalSelfModificationExtension } from "./scaffold.js";

export const SELF_MODIFICATION_CONFIG_PATH = "agent/extensions/self-modification/extension.ts";
export const DEPLOYED_SELF_MODIFICATION_CONFIG_PATH =
  "agent/extensions/self-modification-remote/extension.ts";

const runFile = promisify(execFile);
const GENERATED_MARKER = "// eve-self-modification: generated-v1";
const LEGACY_LOCAL_CONFIG =
  'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n';
const DEFAULT_EXTENSION = renderLocalSelfModificationExtension();
const LEGACY_DEFAULT_EXTENSION = DEFAULT_EXTENSION.replace(
  '"eve/self-modification/local"',
  '"eve/self-modification"',
);

export interface SelfModificationSetupValues {
  readonly baseBranch: string;
  /** Channel names under `agent/channels/`; each gets a deny-by-default `authorize` branch. */
  readonly channelNames: readonly string[];
  readonly connector: string;
  readonly directory: string;
  readonly repository: string;
}
export interface DetectedGitRepository {
  readonly branch?: string;
  readonly directory?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly remoteKind: "github" | "missing" | "other";
}
/**
 * Whether the base branch blocks direct writes. `pull-request-required` comes from a
 * repository ruleset; classic branch protection reads as `protected` because its rules
 * are visible only to repository administrators.
 */
export type BranchProtectionStatus =
  | "pull-request-required"
  | "protected"
  | "unprotected"
  | "unknown";

export interface SelfModificationSetupOperations {
  attachConnector(connector: string, project: VercelProjectReference): Promise<void>;
  /** Reads the base branch's protection with the local GitHub CLI's credentials. */
  checkBranchProtection(repository: string, branch: string): Promise<BranchProtectionStatus>;
  detectChannelNames(): Promise<readonly string[]>;
  detectGitRepository(): Promise<DetectedGitRepository>;
  findOrCreateConnector(name: string, project: VercelProjectReference): Promise<string>;
  /** Reads the deployed mount at {@link DEPLOYED_SELF_MODIFICATION_CONFIG_PATH}. */
  readConfig(): Promise<string | undefined>;
  /** Reads the local mount at {@link SELF_MODIFICATION_CONFIG_PATH}. */
  readLocalConfig(): Promise<string | undefined>;
  /** Writes the deployed mount at {@link DEPLOYED_SELF_MODIFICATION_CONFIG_PATH}. */
  writeConfig(source: string): Promise<void>;
}

export interface SelfModificationSetupDependencies {
  /** Runs `gh` with the given arguments and returns stdout, or `undefined` when it fails. */
  captureGitHub: (args: readonly string[]) => Promise<string | undefined>;
  captureVercel: typeof captureVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const defaultDependencies: SelfModificationSetupDependencies = {
  captureGitHub,
  captureVercel,
  runVercelCaptureStdout,
};

export function connectorName(owner: string, repo: string): string {
  return `selfmod-${owner}-${repo}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
}

export function renderSelfModificationConfig(values?: SelfModificationSetupValues): string {
  if (values === undefined) return DEFAULT_EXTENSION;

  const channelNames = [...new Set(values.channelNames)].filter((name) => name !== "eve").sort();
  const channelCases = channelNames
    .map(
      (name) => `      case ${JSON.stringify(`channel:${name}`)}:
        // Authorize trusted principals for this channel before returning true.
        return false;
`,
    )
    .join("");
  // Admits only this Vercel project's own OIDC identity, which `eve dev <deployment-url>` uses.
  const httpCase = `      case "http": {
        const projectId = process.env.VERCEL_PROJECT_ID;
        return (
          projectId !== undefined &&
          projectId.length > 0 &&
          principal?.authenticator === "oidc" &&
          (principal.issuer === "https://oidc.vercel.com" ||
            principal.issuer?.startsWith("https://oidc.vercel.com/") === true) &&
          principal.attributes.project_id === projectId
        );
      }
`;
  const body = `import selfModification from "eve/self-modification/remote";

export default selfModification({
  authorize: ({ channel, principal }) => {
    switch (channel.kind) {
${httpCase}${channelCases}      default:
        // Add another branch when you add a trusted channel.
        return false;
    }
  },
  github: {
    repository: ${JSON.stringify(values.repository)},
    connector: ${JSON.stringify(values.connector)},
  },
  directory: ${JSON.stringify(values.directory)},
  baseBranch: ${JSON.stringify(values.baseBranch)},
  // model: "provider/model",
  // reasoning: "high",
});
`;
  return `${GENERATED_MARKER} digest:${createHash("sha256").update(body).digest("hex")}\n${body}`;
}

/** Distinguishes resumable generated source from authored source without evaluating it. */
export function classifySelfModificationConfig(
  source: string | undefined,
): "missing" | "local" | "generated" | "authored" {
  if (source === undefined) return "missing";
  if (
    source === DEFAULT_EXTENSION ||
    source === LEGACY_DEFAULT_EXTENSION ||
    source === LEGACY_LOCAL_CONFIG
  ) {
    return "local";
  }
  const [marker, ...body] = source.split("\n");
  const match = /^\/\/ eve-self-modification: generated-v1 digest:([a-f0-9]{64})$/u.exec(
    marker ?? "",
  );
  return match?.[1] === createHash("sha256").update(body.join("\n")).digest("hex")
    ? "generated"
    : "authored";
}

export function parseGitHubRemote(remote: string): { owner: string; repo: string } | undefined {
  const match = remote
    .trim()
    .match(
      /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/u,
    );
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], repo: match[2] };
}

export function defaultSelfModificationSetupOperations(
  appRoot: string,
  deps: SelfModificationSetupDependencies = defaultDependencies,
  projectRoot: string = appRoot,
): SelfModificationSetupOperations {
  const configPath = join(appRoot, DEPLOYED_SELF_MODIFICATION_CONFIG_PATH);
  return {
    async checkBranchProtection(repository, branch) {
      const ref = encodeURIComponent(branch);
      const [rules, details] = await Promise.all([
        deps.captureGitHub(["api", `repos/${repository}/rules/branches/${ref}`]),
        deps.captureGitHub(["api", `repos/${repository}/branches/${ref}`]),
      ]);
      return branchProtectionStatus(rules, details);
    },
    async detectChannelNames() {
      const discovered = await discoverAgent({ appRoot, agentRoot: join(appRoot, "agent") });
      return discovered.manifest.channels.map((source) =>
        stripLogicalPathExtension(source.logicalPath).replace(/^channels\//, ""),
      );
    },
    async detectGitRepository() {
      const remote = await gitOutput(appRoot, ["config", "--get", "remote.origin.url"]);
      const repository = remote === undefined ? undefined : parseGitHubRemote(remote);
      const remoteHead = await gitOutput(appRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const repositoryRoot = await gitOutput(appRoot, ["rev-parse", "--show-toplevel"]);
      return {
        ...repository,
        branch: remoteHead?.replace(/^origin\//u, ""),
        directory:
          repositoryRoot === undefined
            ? undefined
            : repositoryRelativeDirectory(repositoryRoot, appRoot),
        remoteKind:
          remote === undefined ? "missing" : repository === undefined ? "other" : "github",
      };
    },
    readConfig: () => readOptionalFile(configPath),
    readLocalConfig: () => readOptionalFile(join(appRoot, SELF_MODIFICATION_CONFIG_PATH)),
    async writeConfig(source) {
      await mkdir(join(configPath, ".."), { recursive: true });
      await writeFile(configPath, source, "utf8");
    },
    async findOrCreateConnector(name, project) {
      const connectors = await listGitHubConnectors(projectRoot, project, deps.captureVercel);
      const expected = `github/${name}`;
      const existing = connectors.find((connector) => connector.uid === expected);
      if (existing !== undefined) {
        if (existing.type !== "github")
          throw new Error(`The existing connector ${expected} is not a GitHub connector.`);
        return existing.uid;
      }
      const created = await deps.runVercelCaptureStdout(
        ["connect", "create", "github", "--name", name, "-F", "json", "--scope", project.orgId],
        { cwd: projectRoot },
      );
      const connector = created.ok ? parseCreatedConnector(created.stdout) : undefined;
      if (connector === undefined || !connector.startsWith("github/"))
        throw new Error("Could not create a GitHub Vercel Connect connector.");
      return connector;
    },
    async attachConnector(connector, project) {
      const result = await deps.runVercelCaptureStdout(
        [
          "connect",
          "attach",
          connector,
          "--project",
          project.projectId,
          "--environment",
          "production",
          "--yes",
          "--scope",
          project.orgId,
        ],
        { cwd: projectRoot },
      );
      if (!result.ok)
        throw new Error(
          `Could not attach ${connector} to the selected Vercel project for Production.`,
        );
    },
  };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseCreatedConnector(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { uid?: unknown };
    return typeof value.uid === "string" ? value.uid : undefined;
  } catch {
    return undefined;
  }
}

function parseConnectorListPage(
  stdout: string,
): { connectors: { type: string; uid: string }[]; cursor?: string } | undefined {
  try {
    const parsed = JSON.parse(stdout) as { connectors?: unknown; cursor?: unknown };
    if (!Array.isArray(parsed.connectors)) return undefined;
    const connectors = parsed.connectors.flatMap((value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { uid?: unknown }).uid === "string" &&
      typeof (value as { type?: unknown }).type === "string"
        ? [{ uid: (value as { uid: string }).uid, type: (value as { type: string }).type }]
        : [],
    );
    return typeof parsed.cursor === "string"
      ? { connectors, cursor: parsed.cursor }
      : { connectors };
  } catch {
    return undefined;
  }
}

async function listGitHubConnectors(
  appRoot: string,
  project: VercelProjectReference,
  capture: typeof captureVercel,
): Promise<{ type: string; uid: string }[]> {
  const connectors: { type: string; uid: string }[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const args = [
      "connect",
      "list",
      "--all-projects",
      "--service",
      "github",
      "-F",
      "json",
      "--scope",
      project.orgId,
    ];
    if (cursor !== undefined) args.push("--next", cursor);
    const result: VercelCaptureResult = await capture(args, { cwd: appRoot });
    if (!result.ok)
      throw new Error(
        `Could not list GitHub connectors for the selected Vercel project. ${result.failure.message}`,
      );
    const page = parseConnectorListPage(result.stdout);
    if (page === undefined)
      throw new Error("Vercel returned an invalid GitHub connector list for the selected project.");
    connectors.push(...page.connectors);
    if (page.cursor !== undefined && seenCursors.has(page.cursor))
      throw new Error(`The GitHub connector list repeated cursor ${page.cursor}.`);
    if (page.cursor !== undefined) seenCursors.add(page.cursor);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return connectors;
}
export function repositoryRelativeDirectory(
  repositoryRoot: string,
  appRoot: string,
  relativePath: typeof relative = relative,
): string {
  return relativePath(repositoryRoot, appRoot).replaceAll("\\", "/") || ".";
}
export function repositoryOwnerError(value: string): string | undefined {
  return isGitHubOwner(value) ? undefined : "Enter a valid GitHub user or organization name.";
}
export function repositoryNameError(value: string): string | undefined {
  return isGitHubRepositoryName(value) ? undefined : "Enter a valid GitHub repository name.";
}
export function directoryError(value: string): string | undefined {
  return isRepositoryRelativeDirectory(value)
    ? undefined
    : 'Enter a safe repository-relative directory or ".".';
}
export function gitRefError(value: string): string | undefined {
  return isBranchName(value) ? undefined : "Enter a valid branch name.";
}
/** Classifies `gh api` responses for a branch's active rules and its branch details. */
export function branchProtectionStatus(
  rules: string | undefined,
  details: string | undefined,
): BranchProtectionStatus {
  const activeRules = parseJson(rules);
  if (
    Array.isArray(activeRules) &&
    activeRules.some((rule) => isRecord(rule) && rule.type === "pull_request")
  ) {
    return "pull-request-required";
  }
  const branch = parseJson(details);
  if (!Array.isArray(activeRules) || !isRecord(branch)) return "unknown";
  return branch.protected === true ? "protected" : "unprotected";
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function captureGitHub(args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await runFile("gh", [...args], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      timeout: 15_000,
    });
    return result.stdout;
  } catch {
    // A missing, signed-out, or unauthorized GitHub CLI leaves protection unverified.
    return undefined;
  }
}

async function gitOutput(appRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runFile("git", args, { cwd: appRoot });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
