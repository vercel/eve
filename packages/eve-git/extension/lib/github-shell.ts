import { posix } from "node:path";
import { getToken } from "@vercel/connect";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import type { ToolAuthProvider, ToolContext } from "eve/tools";

import {
  attributeCommand,
  coAuthorTrailer,
  isAttributable,
  type GitHubCoAuthor,
} from "./attribution.ts";
import { validateRepositoryRoot } from "./repository-root.ts";
import { connectUserAuthorization } from "./connect-user-auth.ts";
import { shellQuote } from "./shell.ts";
import { GITHUB_TOOLING_PATHS } from "./tooling.ts";

export type { GitHubCoAuthor } from "./attribution.ts";

export interface GitHubShellInput {
  readonly command: string;
  readonly description: string;
  /** The `owner/name` repository the command acts on, an `owner` for discovery, or omitted. */
  readonly repository?: string;
  readonly workingDirectory?: string;
}

export interface GitHubShellOutput {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

/** Resolves the co-author credited by this turn's GitHub publishing commands. */
export type GitHubAttribution = (
  ctx: ToolContext,
) => GitHubCoAuthor | null | PromiseLike<GitHubCoAuthor | null>;

interface GitHubConfigBase {
  /**
   * Resolves who the current turn publishes for. When it returns a person,
   * `gh-signed-commit` messages and `gh pr create` bodies end with their
   * `Co-authored-by` trailer. Return `null` to publish without one. It
   * receives the `gh` tool's context, so `ctx.getToken` can resolve the
   * requester's linked accounts.
   */
  readonly attribution?: GitHubAttribution;
  readonly broker: (
    sandbox: SandboxSession,
    rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
  ) => Promise<void>;
  readonly connector: string;
}

/** Mints GitHub App installation tokens scoped to the declared repository or owner. */
export interface GitHubAppConfig extends GitHubConfigBase {
  /** The only access control: commands run only when it returns `true`. */
  readonly authorize: GitHubAuthorize<GitHubAppAuthorizeRequest>;
  readonly principalType: "app";
}

/** Resolves the caller's own token through `ctx.getToken`, signing them in when needed. */
export interface GitHubUserConfig extends GitHubConfigBase {
  /** The only access control: commands run only when it returns `true`. */
  readonly authorize: GitHubAuthorize<GitHubUserAuthorizeRequest>;
  readonly principalType: "user";
}

export type GitHubConfig = GitHubAppConfig | GitHubUserConfig;

/** What an `authorize` callback sees before a `gh` command runs with the caller's own token. */
export interface GitHubUserAuthorizeRequest {
  /** The parsed command, such as `["gh", "pr", "view", "7", "--repo", "acme/widgets"]`. */
  readonly argv: readonly string[];
  /** The session's current caller, or `null` when the session has none. */
  readonly auth: SessionAuthContext | null;
  /** The `owner/name` repository the command declared, or `null`. */
  readonly repository: string | null;
  /** The token Connect minted for this command, for API lookups. It reaches the command only after `authorize` returns `true`. */
  readonly token: string;
}

/** What an `authorize` callback sees before a `gh` command runs with an installation token. */
export interface GitHubAppAuthorizeRequest extends GitHubUserAuthorizeRequest {
  /** The owner whose installation minted the token. */
  readonly owner: string;
}

export type GitHubAuthorizeRequest = GitHubAppAuthorizeRequest | GitHubUserAuthorizeRequest;

/** Decides whether the session's caller may run one `gh` command; the agent's only access control. */
export type GitHubAuthorize<Request extends GitHubAuthorizeRequest = GitHubAuthorizeRequest> = (
  request: Request,
) => boolean | Promise<boolean>;

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
  /** The calling tool's context, passed to `attribution`. */
  readonly context?: ToolContext;
  readonly auth?: SessionAuthContext | null;
  readonly getConnectToken?: (
    connector: string,
    params: {
      authorizationDetails: {
        type: "github_app_installation";
        org: string;
        repositories?: string[];
      }[];
      subject: { type: "app" };
    },
  ) => Promise<string>;
  /** Resolves and re-authorizes user-scoped providers; the tool's `ctx.getToken` and `ctx.requireAuth`. */
  readonly getToken?: ToolContext["getToken"];
  readonly requireAuth?: ToolContext["requireAuth"];
  readonly getSandbox: () => Promise<SandboxSession>;
  /** Serializes credential leases per eve session; every `ctx.getSandbox()` call returns a new handle. */
  readonly sessionId: string;
}

const MAX_OUTPUT_BYTES = 100_000;
const leaseQueues = new Map<string, Promise<void>>();
const EXECUTABLES = new Set(["gh", "git", "gh-signed-commit"]);
const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:\/([A-Za-z0-9._-]+))?$/u;
/** How `gh` and `git` report a rejected token. */
const GITHUB_UNAUTHORIZED = /HTTP 401\b|Bad credentials|Authentication failed for|failed: 401\b/u;

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
  const { owner, repository, name } = declaredTarget(input.repository);
  if (config.principalType === "user" ? owner && !repository : !owner) {
    throw new Error(
      config.principalType === "user"
        ? "Set repository to owner/name or omit it; user tokens are not scoped to an owner."
        : "App tokens need repository set to an owner or owner/name.",
    );
  }
  const sandbox = await dependencies.getSandbox();
  let workingDirectory = resolveWorkingDirectory(sandbox, input.workingDirectory);
  if (argv[0] === "gh-signed-commit") {
    workingDirectory = await validateRepositoryRoot(sandbox, workingDirectory);
  }
  const invocationId = crypto.randomUUID();
  const bodyFile = `/tmp/eve-git-body-${invocationId}.md`;
  const auth = dependencies.auth ?? null;
  let userAuth: ToolAuthProvider | undefined;
  let token: string;
  if (config.principalType === "user") {
    if (!dependencies.getToken || !dependencies.requireAuth)
      throw new Error("User-scoped GitHub access requires ctx.getToken and ctx.requireAuth.");
    // Connect matches a user grant only to the exact authorization details it
    // was consented with, and repository details do not narrow user tokens.
    // One unscoped grant therefore covers every repository after one sign-in.
    userAuth = connectUserAuthorization(config.connector);
    ({ token } = await dependencies.getToken(userAuth));
  } else {
    // Scope the installation token to the repository, or to the owner's
    // installation for owner-level commands such as `gh repo list <owner>`.
    const installation: { type: "github_app_installation"; org: string; repositories?: string[] } =
      { type: "github_app_installation", org: owner! };
    if (name) installation.repositories = [name];
    token = await (dependencies.getConnectToken ?? getToken)(config.connector, {
      authorizationDetails: [installation],
      subject: { type: "app" },
    });
  }
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(config.connector)}.`);
  const allowed =
    config.principalType === "user"
      ? await config.authorize({ argv, auth, repository, token })
      : await config.authorize({ argv, auth, owner: owner!, repository, token });
  if (!allowed) {
    throw new Error(
      `The current caller is not authorized to run this command${repository ? ` on ${repository}` : owner ? ` for ${owner}` : ""}.`,
    );
  }
  const coAuthor =
    config.attribution && dependencies.context && isAttributable(argv)
      ? await config.attribution(dependencies.context)
      : null;
  const commandArgv = coAuthor
    ? await attributeCommand(argv, coAuthorTrailer(coAuthor), sandbox, workingDirectory, bodyFile)
    : argv;

  const executable = executablePath(commandArgv[0]!);
  const command = `cd ${shellQuote(workingDirectory)} && exec ${shellQuote(executable)} ${commandArgv
    .slice(1)
    .map(shellQuote)
    .join(" ")}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const placeholder = `eve-github-${invocationId}`;
  const githubConfig = `/tmp/eve-code-gh-${invocationId}`;
  const placeholderAuthorization = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString("base64")}`;
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await withGitHubCredentialLease(
      sandbox,
      dependencies.sessionId,
      { authorization, placeholder, placeholderAuthorization, token },
      () => {
        const env: Record<string, string> = {
          GH_CONFIG_DIR: githubConfig,
          GH_PROMPT_DISABLED: "1",
        };
        if (argv[0] !== "git") env.GH_TOKEN = placeholder;
        // Applies to every git process, including the ones gh starts: the
        // credential header reaches only HTTPS GitHub, and no hooks run.
        const gitConfig: [string, string][] = [
          ["http.https://github.com/.extraheader", `Authorization: ${placeholderAuthorization}`],
          ["core.hooksPath", "/dev/null"],
          ["protocol.allow", "never"],
          ["protocol.https.allow", "always"],
        ];
        env.GIT_CONFIG_COUNT = String(gitConfig.length);
        gitConfig.forEach(([key, value], index) => {
          env[`GIT_CONFIG_KEY_${index}`] = key;
          env[`GIT_CONFIG_VALUE_${index}`] = value;
        });
        env.GIT_TERMINAL_PROMPT = "0";
        env.PATH = "/usr/local/bin:/usr/bin:/bin";
        return sandbox.run({ command, env });
      },
      config.broker,
    );
  } finally {
    await sandbox.removePath({ path: githubConfig, recursive: true, force: true });
    await sandbox.removePath({ path: bodyFile, force: true });
  }
  if (userAuth && result.exitCode !== 0 && GITHUB_UNAUTHORIZED.test(result.stderr)) {
    // GitHub rejected the caller's token: evict it and sign the caller in again.
    dependencies.requireAuth!(userAuth);
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
  sessionId: string,
  credential: {
    readonly authorization: string;
    readonly placeholder: string;
    readonly placeholderAuthorization: string;
    readonly token: string;
  },
  run: () => PromiseLike<T>,
  broker: GitHubConfig["broker"],
): Promise<T> {
  const previous = leaseQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  leaseQueues.set(sessionId, current);
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
      if (leaseQueues.get(sessionId) === current) leaseQueues.delete(sessionId);
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
  if (!input.description.trim()) throw new Error("description must describe the intended result.");
  // The credential lease is wired only into these executables: gh reads the
  // placeholder GH_TOKEN and git sends the placeholder header.
  if (!EXECUTABLES.has(argv[0]!)) {
    throw new Error("GitHub commands must use gh, git, or gh-signed-commit.");
  }
  if (argv.length < 2) throw new Error(`A ${argv[0]} subcommand or argument is required.`);
  declaredTarget(input.repository);
  return argv;
}

function declaredTarget(value: string | undefined): {
  owner: string | null;
  repository: string | null;
  name: string | null;
} {
  const declared = value?.trim();
  if (!declared) return { owner: null, repository: null, name: null };
  const match = REPOSITORY.exec(declared.replace(/\.git$/iu, ""));
  if (!match) throw new Error(`Invalid GitHub repository or owner ${JSON.stringify(value)}.`);
  const [, owner, name] = match;
  return { owner: owner!, repository: name ? `${owner}/${name}` : null, name: name ?? null };
}

function executablePath(executable: string): string {
  if (executable === "gh") return GITHUB_TOOLING_PATHS.ghReal;
  if (executable === "gh-signed-commit") return GITHUB_TOOLING_PATHS.trustedSignedCommit;
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
