import { posix } from "node:path";
import { getToken, type ConnectTokenParams } from "@vercel/connect";
import type { SandboxSession } from "eve/sandbox";

import { validateRepositoryRoot } from "./repository-root.ts";
import { shellQuote } from "./shell.ts";
import { toolingPaths } from "./tooling.ts";

export interface GitHubPermission {
  readonly access: "write";
  readonly provider: "github";
  readonly repositories: readonly string[];
}

export interface GitHubShellInput {
  readonly command: string;
  readonly description: string;
  readonly permissions: readonly [GitHubPermission];
  readonly workingDirectory?: string;
}

export interface GitHubShellOutput {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

interface GitHubConfig {
  readonly broker: (
    sandbox: SandboxSession,
    rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
  ) => Promise<void>;
  readonly connector: string;
  readonly org: string;
}

export interface GitHubLeaseRule {
  readonly match?: {
    readonly headers?: readonly {
      readonly key?: { readonly exact: string };
      readonly value?: { readonly exact?: string; readonly regex?: string };
    }[];
  };
  readonly transform: readonly { readonly headers: Readonly<Record<string, string>> }[];
}

interface GitHubShellDependencies {
  readonly getConnectToken?: typeof getToken;
  readonly getSandbox: () => Promise<SandboxSession>;
}

const MAX_OUTPUT_BYTES = 100_000;
const leaseQueues = new Map<string, Promise<void>>();
const ALLOWED_GIT_REMOTE_COMMANDS = new Set(["fetch", "ls-remote", "pull", "push"]);

export function githubShellApproval(input: GitHubShellInput | undefined) {
  if (!input) return "not-applicable" as const;
  try {
    validateGitHubShellInput(input);
    return "not-applicable" as const;
  } catch (error) {
    return {
      type: "denied" as const,
      reason: error instanceof Error ? error.message : "Invalid GitHub command.",
    };
  }
}

export async function executeGitHubShell(
  input: GitHubShellInput,
  config: GitHubConfig | undefined,
  dependencies: GitHubShellDependencies,
): Promise<GitHubShellOutput> {
  if (!config) throw new Error("GitHub command access is not configured for this agent.");
  const argv = validateGitHubShellInput(input);
  const sandbox = await dependencies.getSandbox();
  let workingDirectory = resolveWorkingDirectory(sandbox, input.workingDirectory);
  if (argv[0] === "git" || argv[0] === "gh-signed-commit") {
    workingDirectory = await validateRepositoryRoot(sandbox, workingDirectory);
  }
  const declaredRepositories = input.permissions[0].repositories;
  const remoteRepository = await assertCommandTargets(
    argv,
    declaredRepositories,
    workingDirectory,
    sandbox,
  );
  const repositories = repositoryNames(declaredRepositories, config.org);
  const tokenParams: ConnectTokenParams = {
    authorizationDetails: [{ type: "github_app_installation", org: config.org, repositories }],
    subject: { type: "app" },
  };
  const token = await (dependencies.getConnectToken ?? getToken)(config.connector, tokenParams);
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(config.connector)}.`);

  const executable = executablePath(argv[0]!, sandbox);
  const executionArguments = remoteRepository
    ? [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        argv[1]!,
        `https://github.com/${remoteRepository}.git`,
        ...argv.slice(3),
      ]
    : argv.slice(1);
  const command = `cd ${shellQuote(workingDirectory)} && exec ${shellQuote(executable)} ${executionArguments
    .map(shellQuote)
    .join(" ")}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const invocationId = crypto.randomUUID();
  const placeholder = `eve-github-${invocationId}`;
  const githubConfig = `/tmp/eve-code-gh-${invocationId}`;
  const placeholderAuthorization = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString("base64")}`;
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await withGitHubCredentialLease(
      sandbox,
      { authorization, placeholder, placeholderAuthorization, token },
      () => {
        const env: Record<string, string> = {
          GH_CONFIG_DIR: githubConfig,
          GH_PROMPT_DISABLED: "1",
        };
        if (argv[0] !== "git") env.GH_TOKEN = placeholder;
        env.GIT_CONFIG_COUNT = "2";
        env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
        env.GIT_CONFIG_VALUE_0 = `Authorization: ${placeholderAuthorization}`;
        env.GIT_CONFIG_KEY_1 = "core.hooksPath";
        env.GIT_CONFIG_VALUE_1 = "/dev/null";
        env.GIT_TERMINAL_PROMPT = "0";
        env.PATH = "/usr/local/bin:/usr/bin:/bin";
        return sandbox.run({ command, env });
      },
      config.broker,
    );
  } finally {
    await sandbox.removePath({ path: githubConfig, recursive: true, force: true });
  }
  const stdout = sanitizeOutput(result.stdout, token, authorization);
  const stderr = sanitizeOutput(result.stderr, token, authorization);
  return {
    exitCode: result.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated,
  };
}

async function withGitHubCredentialLease<T>(
  sandbox: SandboxSession,
  credential: {
    readonly authorization: string;
    readonly placeholder: string;
    readonly placeholderAuthorization: string;
    readonly token: string;
  },
  run: () => PromiseLike<T>,
  broker: GitHubConfig["broker"],
): Promise<T> {
  const previous = leaseQueues.get(sandbox.id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  leaseQueues.set(sandbox.id, current);
  await previous;
  try {
    await broker(sandbox, {
      "api.github.com": [
        {
          match: {
            headers: [
              {
                key: { exact: "authorization" },
                value: { regex: `^(?:token|Bearer) ${credential.placeholder}$` },
              },
            ],
          },
          transform: [{ headers: { authorization: `Bearer ${credential.token}` } }],
        },
      ],
      "github.com": [
        {
          match: {
            headers: [
              {
                key: { exact: "authorization" },
                value: { exact: credential.placeholderAuthorization },
              },
            ],
          },
          transform: [{ headers: { authorization: credential.authorization } }],
        },
      ],
    });
    return await run();
  } finally {
    try {
      await broker(sandbox, null);
    } finally {
      release();
      if (leaseQueues.get(sandbox.id) === current) leaseQueues.delete(sandbox.id);
    }
  }
}

export function parseCommand(command: string): string[] {
  const value = command.trim();
  if (!value) throw new Error("GitHub command must not be empty.");
  const argv: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") throw unsupportedSyntax();
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
    } else if (character === '"') {
      quote = "double";
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else if (";&|<>$`(){}".includes(character)) {
      throw unsupportedSyntax();
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote) throw new Error("GitHub command contains an unfinished quote or escape.");
  if (started) argv.push(token);
  if (argv.length === 0) throw new Error("GitHub command must not be empty.");
  return argv;
}

function validateGitHubShellInput(input: GitHubShellInput): string[] {
  const argv = parseCommand(input.command);
  if (input.permissions.length !== 1 || input.permissions[0].provider !== "github") {
    throw new Error("Exactly one GitHub permission is required.");
  }
  if (input.permissions[0].access !== "write") {
    throw new Error("GitHub App commands require explicit write-capable access.");
  }
  if (!input.description.trim()) throw new Error("description must describe the intended result.");
  const [executable, subcommand] = argv;
  if (executable === "gh") {
    if (!subcommand) throw new Error("A gh subcommand is required.");
  } else if (executable === "git") {
    if (!subcommand || !ALLOWED_GIT_REMOTE_COMMANDS.has(subcommand)) {
      throw new Error(
        "Authenticated git supports only fetch, ls-remote, pull, and push; clone with gh repo clone.",
      );
    }
  } else if (executable !== "gh-signed-commit") {
    throw new Error(
      "GitHub commands must use gh, an authenticated git remote command, or gh-signed-commit.",
    );
  }
  return argv;
}

async function assertCommandTargets(
  argv: readonly string[],
  declaredRepositories: readonly string[],
  workingDirectory: string,
  sandbox: Pick<SandboxSession, "run">,
): Promise<string | undefined> {
  const declared = new Set(declaredRepositories.map((repository) => repository.toLowerCase()));
  let remoteRepository: string | undefined;
  let targets: string[];
  if (argv[0] === "git") {
    if (argv[2] !== "origin") {
      throw new Error("Authenticated git commands must use the validated origin remote.");
    }
    const push = argv[1] === "push";
    const remote = await sandbox.run({
      command: `cd ${shellQuote(workingDirectory)} && git remote get-url ${push ? "--push " : ""}origin`,
      env: { GIT_TERMINAL_PROMPT: "0", PATH: "/usr/bin:/bin" },
    });
    if (remote.exitCode !== 0) throw new Error("Could not resolve the origin GitHub repository.");
    remoteRepository = repositoryFromRemote(remote.stdout.trim());
    targets = [remoteRepository];
  } else if (argv[0] === "gh-signed-commit") {
    targets = repoFlagTargets(argv.slice(1));
    if (targets.length === 0) {
      throw new Error("gh-signed-commit requires an explicit --repo owner/repository target.");
    }
  } else {
    targets = repoFlagTargets(argv.slice(1));
    if (
      argv[1] === "repo" &&
      (argv[2] === "clone" || argv[2] === "view" || argv[2] === "fork") &&
      argv[3] &&
      !argv[3].startsWith("-")
    ) {
      targets.push(canonicalRepository(argv[3]));
    }
  }
  for (const target of targets) {
    if (!declared.has(target.toLowerCase())) {
      throw new Error(
        `Command target ${JSON.stringify(target)} is not in the declared repositories.`,
      );
    }
  }
  return remoteRepository;
}

function repoFlagTargets(argv: readonly string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo" || value === "-R") {
      const target = argv[index + 1];
      if (!target) throw new Error(`${value} requires an owner/repository value.`);
      targets.push(canonicalRepository(target));
      index += 1;
    } else if (value?.startsWith("--repo=")) {
      targets.push(canonicalRepository(value.slice("--repo=".length)));
    }
  }
  return targets;
}

function repositoryFromRemote(remote: string): string {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(remote);
  if (https?.[1]) return canonicalRepository(https[1]);
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(remote);
  if (ssh?.[1]) return canonicalRepository(ssh[1]);
  throw new Error("The origin remote is not a canonical GitHub repository URL.");
}

function canonicalRepository(value: string): string {
  const normalized = value.replace(/\.git$/iu, "");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function repositoryNames(repositories: readonly string[], configuredOrg: string): string[] {
  if (repositories.length !== 1) throw new Error("Exactly one GitHub repository is required.");
  const names = new Set<string>();
  for (const repository of repositories) {
    const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/u.exec(repository);
    if (!match) throw new Error(`Invalid GitHub repository ${JSON.stringify(repository)}.`);
    if (match[1]?.toLowerCase() !== configuredOrg.toLowerCase()) {
      throw new Error(`Repository ${JSON.stringify(repository)} is outside ${configuredOrg}.`);
    }
    names.add(match[2]!);
  }
  if (names.size !== 1) throw new Error("Exactly one GitHub repository is required.");
  return [...names];
}

function executablePath(executable: string, sandbox: Pick<SandboxSession, "resolvePath">): string {
  if (executable === "gh") return toolingPaths(sandbox).ghReal;
  if (executable === "gh-signed-commit") return toolingPaths(sandbox).trustedSignedCommit;
  return "git";
}

function resolveWorkingDirectory(
  sandbox: Pick<SandboxSession, "resolvePath">,
  workingDirectory: string | undefined,
): string {
  const workspace = posix.resolve("/", sandbox.resolvePath(""));
  const resolved = posix.resolve("/", sandbox.resolvePath(workingDirectory?.trim() || ""));
  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error("GitHub command workingDirectory must stay inside the sandbox workspace.");
  }
  return resolved;
}

function sanitizeOutput(
  value: string,
  token: string,
  authorization: string,
): { readonly truncated: boolean; readonly value: string } {
  const redacted = value.replaceAll(token, "[redacted]").replaceAll(authorization, "[redacted]");
  if (Buffer.byteLength(redacted) <= MAX_OUTPUT_BYTES) return { value: redacted, truncated: false };
  return {
    value: `[output truncated: showing final ${MAX_OUTPUT_BYTES} bytes]\n${Buffer.from(redacted).subarray(-MAX_OUTPUT_BYTES).toString()}`,
    truncated: true,
  };
}

function unsupportedSyntax(): Error {
  return new Error(
    "GitHub commands support argv syntax only, not pipes, redirects, substitutions, or shell operators.",
  );
}
