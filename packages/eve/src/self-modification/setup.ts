import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

import { SELF_MODIFICATION_CONFIG_PATH } from "./git-workspace.js";

const runFile = promisify(execFile);
const GENERATED_MARKER = "// eve-self-modification: generated-v1";
const LEGACY_LOCAL_CONFIG =
  'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n';

export interface SelfModificationSetupValues {
  readonly branch: string;
  readonly channelNames: readonly string[];
  readonly connector: string;
  readonly directory: string;
  readonly repository: string;
  readonly vercelBackend: boolean;
}
export interface DetectedGitRepository {
  readonly branch?: string;
  readonly directory?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly remoteKind: "github" | "missing" | "other";
}
export interface SelfModificationSetupOperations {
  attachConnector(connector: string, project: VercelProjectReference): Promise<void>;
  detectChannelNames(): Promise<readonly string[]>;
  detectGitRepository(): Promise<DetectedGitRepository>;
  findOrCreateConnector(name: string, project: VercelProjectReference): Promise<string>;
  readConfig(): Promise<string | undefined>;
  writeConfig(source: string): Promise<void>;
}

export interface SelfModificationSetupDependencies {
  captureVercel: typeof captureVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const defaultDependencies: SelfModificationSetupDependencies = {
  captureVercel,
  runVercelCaptureStdout,
};

export function connectorName(owner: string, repo: string): string {
  return `selfmod-${owner}-${repo}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
}

export function renderSelfModificationConfig(values?: SelfModificationSetupValues): string {
  if (values === undefined) {
    return `import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({\n  local: { enabled: true },\n});\n`;
  }
  const channelNames = [...new Set(values.channelNames)].filter((name) => name !== "eve").sort();
  const channelCases = (values.vercelBackend ? channelNames : [])
    .map(
      (name) => `      case ${JSON.stringify(`channel:${name}`)}:
        // Authorize trusted principals for this channel before returning true.
        return false;`,
    )
    .join("\n");
  const httpCase = values.vercelBackend
    ? `        case "http": {
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
`
    : "";
  const switchCases = `${httpCase}${channelCases}`;
  const credentialErrorMessage = `Self-modification could not obtain a GitHub credential from Vercel Connect for ${values.connector}. Install and attach the configured GitHub connector to this Vercel project, install the managed GitHub App for the configured repository, then retry.`;
  const body = `import { getToken } from "@vercel/connect";
import { defineSelfModificationConfig } from "eve/self-modification/config";

export default defineSelfModificationConfig({
  deployed: {
    source: {
      git: {
        repository: ${JSON.stringify(values.repository)},
        directory: ${JSON.stringify(values.directory)},
      },
    },
    target: { branch: ${JSON.stringify(values.branch)} },
    credentials: {
      async resolve({ capability, repository }) {
        try {
          return await getToken(${JSON.stringify(values.connector)}, {
            authorizationDetails: [
              {
                type: "github_app_installation",
                repositories: [repository.owner + "/" + repository.repo],
              },
            ],
            scopes:
              capability === "checkout"
                ? ["contents:read", "metadata:read"]
                : ["contents:write", "pull_requests:write", "metadata:read"],
            subject: { type: "app" },
          });
        } catch (error) {
          throw new Error(${JSON.stringify(credentialErrorMessage)}, { cause: error });
        }
      },
    },
    authorize: ({ channel, principal }) => {
      switch (channel.kind) {
${switchCases}        default:
          // Add another branch when you add a trusted channel.
          return false;
      }
    },
  },
});
`;
  return `${GENERATED_MARKER} digest:${createHash("sha256").update(body).digest("hex")}\n${body}`;
}

/** Distinguishes resumable generated source from authored source without evaluating it. */
export function classifySelfModificationConfig(
  source: string | undefined,
): "missing" | "local" | "generated" | "authored" {
  if (source === undefined) return "missing";
  if (source === renderSelfModificationConfig() || source === LEGACY_LOCAL_CONFIG) return "local";
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
  const configPath = join(appRoot, SELF_MODIFICATION_CONFIG_PATH);
  return {
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
    async readConfig() {
      try {
        return await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    writeConfig: (source) => writeFile(configPath, source, "utf8"),
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
export function repositoryPartError(value: string): string | undefined {
  return /^[A-Za-z0-9_.-]+$/u.test(value)
    ? undefined
    : "Enter a valid GitHub owner or repository name.";
}
export function directoryError(value: string): string | undefined {
  return value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
    ? undefined
    : 'Enter a safe repository-relative directory or ".".';
}
export function gitRefError(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{")
    ? undefined
    : "Enter a valid branch name.";
}
async function gitOutput(appRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runFile("git", args, { cwd: appRoot });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
