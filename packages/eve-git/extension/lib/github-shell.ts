import { createHash } from "node:crypto";
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
import {
  GITHUB_COMMAND_TIMEOUT_SECONDS,
  leasePlaceholder,
  withGitHubLease,
  type GitHubLeaseBroker,
  type GitHubLeaseReader,
  type GitHubLeaseScope,
} from "./github-lease.ts";
import { GITHUB_TARGET } from "./github-shell-schema.ts";
import { shellQuote } from "./shell.ts";
import { GITHUB_TOOLING_PATHS } from "./tooling.ts";

export type { GitHubCoAuthor } from "./attribution.ts";
export type {
  GitHubLeaseBroker,
  GitHubLeaseReader,
  GitHubLeaseRule,
  GitHubLeaseRules,
} from "./github-lease.ts";

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
  /**
   * Writes the sandbox's GitHub rules for every live command, replacing the
   * ones it wrote before, and keeps your other network rules. `null` removes
   * them all.
   */
  readonly broker: GitHubLeaseBroker;
  /** Reads back the GitHub rules `broker` last wrote, from the sandbox's live network policy. */
  readonly readRules: GitHubLeaseReader;
  readonly connector: string;
}

/** Mints GitHub App installation tokens scoped to the declared repository or owner. */
export interface GitHubAppConfig extends GitHubConfigBase {
  /** The only access control: commands run only when it returns `true`. */
  readonly authorize: GitHubAuthorize<GitHubAppAuthorizeRequest>;
  readonly principalType: "app";
  /**
   * GitHub App permissions each installation token is limited to, such as
   * `["contents:read"]`. Omit for the installation's own permissions.
   */
  readonly permissions?: readonly string[];
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
  /** Always `null`: user tokens cannot be restricted to the declared repository. Use app tokens for repository allowlists. */
  readonly repository: null;
  /** The token Connect minted for this command, for API lookups. It reaches the command only after `authorize` returns `true`. */
  readonly token: string;
}

/** What an `authorize` callback sees before a `gh` command runs with an installation token. */
export interface GitHubAppAuthorizeRequest extends Omit<GitHubUserAuthorizeRequest, "repository"> {
  /** The repository the installation token is scoped to, or `null` for owner-wide access. */
  readonly repository: string | null;
  /** The owner whose installation minted the token. */
  readonly owner: string;
}

export type GitHubAuthorizeRequest = GitHubAppAuthorizeRequest | GitHubUserAuthorizeRequest;

/** Decides whether the session's caller may run one `gh` command; the agent's only access control. */
export type GitHubAuthorize<Request extends GitHubAuthorizeRequest = GitHubAuthorizeRequest> = (
  request: Request,
) => boolean | Promise<boolean>;

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
        permissions?: string[];
        repositories?: string[];
      }[];
      subject: { type: "app" };
    },
  ) => Promise<string>;
  /** Resolves and re-authorizes user-scoped providers; the tool's `ctx.getToken` and `ctx.requireAuth`. */
  readonly getToken?: ToolContext["getToken"];
  readonly requireAuth?: ToolContext["requireAuth"];
  readonly getSandbox: () => Promise<SandboxSession>;
}

const MAX_OUTPUT_BYTES = 100_000;
const EXECUTABLES = new Set(["gh", "git", "gh-signed-commit"]);
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
  const {
    argv,
    target: { owner, repository, name },
  } = validateGitHubShellInput(input);
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
  let scope: GitHubLeaseScope;
  let tokenFor: (lease: GitHubLeaseScope) => Promise<string | null>;
  if (config.principalType === "user") {
    if (!dependencies.getToken || !dependencies.requireAuth)
      throw new Error("User-scoped GitHub access requires ctx.getToken and ctx.requireAuth.");
    // Connect matches a user grant only to the exact authorization details it
    // was consented with, and repository details do not narrow user tokens.
    // One unscoped grant therefore covers every repository after one sign-in.
    userAuth = connectUserAuthorization(config.connector);
    ({ token } = await dependencies.getToken(userAuth));
    scope = { principal: userPrincipal(config.connector, auth), owner, name, permissions: null };
    // Another live command of the same caller gets this caller's token; any
    // other caller's rule is dropped rather than given this caller's token.
    tokenFor = async (lease) => (lease.principal === scope.principal ? token : null);
  } else {
    const mint = (
      org: string,
      repository: string | null,
      permissions: readonly string[] | null,
    ) => {
      // Scope the installation token to the repository, or to the owner's
      // installation for owner-level commands such as `gh repo list <owner>`.
      const installation: {
        type: "github_app_installation";
        org: string;
        permissions?: string[];
        repositories?: string[];
      } = { type: "github_app_installation", org };
      if (permissions) installation.permissions = [...permissions];
      if (repository) installation.repositories = [repository];
      return (dependencies.getConnectToken ?? getToken)(config.connector, {
        authorizationDetails: [installation],
        subject: { type: "app" },
      });
    };
    const permissions = config.permissions ? [...config.permissions].sort() : null;
    token = await mint(owner!, name, permissions);
    scope = { principal: appPrincipal(config.connector), owner, name, permissions };
    const minted = new Map<string, Promise<string>>();
    // Another live command's token is re-minted with that command's own
    // permissions, so a write token never reaches a read-only command's rule.
    tokenFor = async (lease) => {
      if (lease.principal !== scope.principal || !lease.owner) return null;
      const key = JSON.stringify([lease.owner, lease.name, lease.permissions]);
      if (!minted.has(key)) minted.set(key, mint(lease.owner, lease.name, lease.permissions));
      return await minted.get(key)!;
    };
  }
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(config.connector)}.`);
  // The declaration is model-controlled and cannot narrow a user token.
  // Never let it satisfy a repository allowlist for an unrestricted lease.
  const allowed =
    config.principalType === "user"
      ? await config.authorize({ argv, auth, repository: null, token })
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
  const command = `cd ${shellQuote(workingDirectory)} && exec timeout -k 10 ${GITHUB_COMMAND_TIMEOUT_SECONDS} ${shellQuote(executable)} ${commandArgv
    .slice(1)
    .map(shellQuote)
    .join(" ")}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const placeholder = leasePlaceholder(scope);
  const githubConfig = `/tmp/eve-code-gh-${invocationId}`;
  const placeholderAuthorization = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString("base64")}`;
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await withGitHubLease(
      sandbox,
      { placeholder, token },
      { broker: config.broker, read: config.readRules, tokenFor },
      () => {
        const env: Record<string, string> = {
          GH_CONFIG_DIR: githubConfig,
          GH_PROMPT_DISABLED: "1",
        };
        if (argv[0] !== "git") env.GH_TOKEN = placeholder;
        // Defaults for every git process, including the ones gh starts. SSH
        // GitHub remotes are rewritten to HTTPS so they carry the credential
        // header. The command's own `-c` options still override these; the
        // lease, not this config, bounds what the command can reach.
        const gitConfig: [string, string][] = [
          ["http.https://github.com/.extraheader", `Authorization: ${placeholderAuthorization}`],
          ["url.https://github.com/.insteadOf", "git@github.com:"],
          ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
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

/** Identifies the caller a user token belongs to, without naming them. */
function userPrincipal(connector: string, auth: SessionAuthContext | null): string {
  const identity = auth
    ? [auth.authenticator, auth.issuer ?? "", auth.principalType, auth.principalId]
    : [];
  return createHash("sha256")
    .update(JSON.stringify([connector, ...identity]))
    .digest("base64url")
    .slice(0, 16);
}

/** Identifies the connector that mints an installation token. */
function appPrincipal(connector: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(["app", connector]))
    .digest("base64url")
    .slice(0, 16);
  return `app.${hash}`;
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

function validateGitHubShellInput(input: GitHubShellInput): {
  argv: string[];
  target: ReturnType<typeof declaredTarget>;
} {
  const argv = parseCommand(input.command);
  if (!input.description.trim()) throw new Error("description must describe the intended result.");
  // The credential lease is wired only into these executables: gh reads the
  // placeholder GH_TOKEN and git sends the placeholder header.
  if (!EXECUTABLES.has(argv[0]!)) {
    throw new Error("GitHub commands must use gh, git, or gh-signed-commit.");
  }
  if (argv.length < 2) throw new Error(`A ${argv[0]} subcommand or argument is required.`);
  return { argv, target: declaredTarget(input.repository) };
}

function declaredTarget(value: string | undefined): {
  owner: string | null;
  repository: string | null;
  name: string | null;
} {
  const declared = value?.trim();
  if (!declared) return { owner: null, repository: null, name: null };
  const match = GITHUB_TARGET.exec(declared.replace(/\.git$/iu, ""));
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
