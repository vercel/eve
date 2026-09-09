import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { SELF_MODIFICATION_CONFIG_PATH } from "./git-workspace.js";

const runFile = promisify(execFile);
const GENERATED_MARKER = "// eve-self-modification: generated-v1";

export interface SelfModificationSetupValues {
  readonly branch: string;
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
export interface SelfModificationSetupOperations {
  attachConnector(connector: string): Promise<void>;
  detectGitRepository(): Promise<DetectedGitRepository>;
  findOrCreateConnector(name: string): Promise<string>;
  readConfig(): Promise<string | undefined>;
  writeConfig(source: string): Promise<void>;
}

export function connectorName(owner: string, repo: string): string {
  return `selfmod-${owner}-${repo}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
}

export function renderSelfModificationConfig(values?: SelfModificationSetupValues): string {
  if (values === undefined) {
    return `import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n`;
  }
  const body = `import { defineSelfModificationConfig } from "eve/self-modification/config";

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
      vercelConnect: { connector: ${JSON.stringify(values.connector)} },
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
  if (source === renderSelfModificationConfig()) return "local";
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
): SelfModificationSetupOperations {
  const configPath = join(appRoot, SELF_MODIFICATION_CONFIG_PATH);
  return {
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
    async findOrCreateConnector(name) {
      const listed = await vercel(appRoot, ["connect", "list", "-F", "json"]);
      if (!listed.ok)
        throw new Error(
          "Vercel Connect requires an authenticated Vercel CLI linked to this project.",
        );
      const connectors = parseConnectors(listed.stdout);
      const expected = `github/${name}`;
      const existing = connectors.find((connector) => connector.uid === expected);
      if (existing !== undefined) {
        if (existing.type !== "github")
          throw new Error(`The existing connector ${expected} is not a GitHub connector.`);
        return existing.uid;
      }
      const created = await vercel(appRoot, [
        "connect",
        "create",
        "github",
        "--name",
        name,
        "-F",
        "json",
      ]);
      const connector = created.ok ? parseCreatedConnector(created.stdout) : undefined;
      if (connector === undefined || !connector.startsWith("github/"))
        throw new Error("Could not create a GitHub Vercel Connect connector.");
      return connector;
    },
    async attachConnector(connector) {
      const link = await readLinkedProject(appRoot);
      if (link === undefined)
        throw new Error(
          "Vercel Connect requires this directory to be linked to a Vercel project. Run `vercel link` and retry.",
        );
      const result = await vercel(appRoot, [
        "connect",
        "attach",
        connector,
        "--project",
        link.projectId,
        "--environment",
        "production",
        "--yes",
      ]);
      if (!result.ok)
        throw new Error(
          `Could not attach ${connector} to the linked Vercel project for Production.`,
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

function parseConnectors(stdout: string): { type: string; uid: string }[] {
  try {
    const parsed = JSON.parse(stdout) as { connectors?: unknown; uid?: unknown; type?: unknown };
    const values = Array.isArray(parsed.connectors) ? parsed.connectors : [parsed];
    return values.flatMap((value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { uid?: unknown }).uid === "string" &&
      typeof (value as { type?: unknown }).type === "string"
        ? [{ uid: (value as { uid: string }).uid, type: (value as { type: string }).type }]
        : [],
    );
  } catch {
    return [];
  }
}
async function vercel(cwd: string, args: string[]) {
  try {
    const result = await runFile("vercel", args, { cwd });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
async function readLinkedProject(appRoot: string): Promise<{ projectId: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(appRoot, ".vercel", "project.json"), "utf8")) as {
      projectId?: unknown;
    };
    return typeof value.projectId === "string" ? { projectId: value.projectId } : undefined;
  } catch {
    return undefined;
  }
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
