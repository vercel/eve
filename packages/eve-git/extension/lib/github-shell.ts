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
import { withSandboxLeaseLock } from "./sandbox-lease-lock.ts";
import { connectUserAuthorization } from "./connect-user-auth.ts";
import { GITHUB_TARGET } from "./github-shell-schema.ts";
import { shellQuote } from "./shell.ts";
import { GITHUB_TOOLING_PATHS } from "./tooling.ts";

export type { GitHubCoAuthor } from "./attribution.ts";

export interface GitHubShellInput {
  readonly command: string;
  readonly description: string;
  /** The `owner/name` repository the command acts on, an `owner` for discovery, or omitted. */
  readonly repository?: string;
  readonly workingDirectory?: string;
  /**
   * The `principalId` of the person whose request the command carries out. With user tokens the
   * command runs with their token, and `authorize` checks them instead of the caller.
   */
  readonly actor?: string;
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
  /**
   * The only access control: commands run only when it returns `true`. In a shared session it
   * is asked about the turn's caller and, when someone else spoke last, about that person too.
   * The command runs only when it returns `true` for both. App tokens act for no one, so the
   * command's `actor` doesn't change it.
   */
  readonly authorize: GitHubAuthorize<GitHubAppAuthorizeRequest>;
  /**
   * Installation permissions each minted token carries, such as `"contents:write"`.
   * Omit it for every permission the App holds.
   */
  readonly permissions?: readonly string[];
  readonly principalType: "app";
}

/**
 * Resolves the caller's own token through `ctx.getToken`, signing them in when needed, or the
 * token of the command's `actor` when it names someone else.
 */
export interface GitHubUserConfig extends GitHubConfigBase {
  /**
   * The only access control: commands run only when it returns `true`. It is asked about the
   * person whose token the command uses: the caller, or the command's `actor`.
   */
  readonly authorize: GitHubAuthorize<GitHubUserAuthorizeRequest>;
  readonly principalType: "user";
}

export type GitHubConfig = GitHubAppConfig | GitHubUserConfig;

/** What an `authorize` callback sees before a `gh` command runs with the caller's own token. */
export interface GitHubUserAuthorizeRequest {
  /** The parsed command, such as `["gh", "pr", "view", "7", "--repo", "acme/widgets"]`. */
  readonly argv: readonly string[];
  /**
   * The person the command is checked for, or `null` when the session has none: the turn's
   * caller, or with user tokens the command's `actor` as eve resolved them, without attributes;
   * with app tokens also whoever spoke last, when that is someone else.
   */
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
  /** Who sent the latest message the turn read; the tool's `ctx.session.auth.sender`. */
  readonly sender?: SessionAuthContext | null;
  readonly getConnectToken?: (
    connector: string,
    params: {
      authorizationDetails: {
        type: "github_app_installation";
        org: string;
        repositories?: string[];
        permissions?: string[];
      }[];
      subject: { type: "app" };
    },
  ) => Promise<string>;
  /** Resolves and re-authorizes user-scoped providers; the tool's `ctx.getToken` and `ctx.requireAuth`. */
  readonly getToken?: ToolContext["getToken"];
  readonly requireAuth?: ToolContext["requireAuth"];
  readonly getSandbox: () => Promise<SandboxSession>;
  /**
   * Orders this session's own credential leases in process; every `ctx.getSandbox()` call returns
   * a new handle. Sessions that share a sandbox are serialized by a lock inside the sandbox.
   */
  readonly sessionId: string;
  /** Stops waiting for another command's credential lease when the tool call is cancelled. */
  readonly abortSignal?: AbortSignal;
}

const MAX_OUTPUT_BYTES = 100_000;
const leaseQueues = new Map<string, Promise<void>>();
const EXECUTABLES = new Set(["gh", "git", "gh-signed-commit"]);
/** How `gh` and `git` report a rejected token. */
const GITHUB_UNAUTHORIZED = /HTTP 401\b|Bad credentials|Authentication failed for|failed: 401\b/u;

/**
 * Thrown when a GitHub command's own input is refused before it runs, such as
 * shell syntax, a working directory outside the workspace, or a missing body
 * file. The agent can fix these by changing the call.
 */
export class GitHubCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubCommandInputError";
  }
}

/**
 * Type guard for {@link GitHubCommandInputError}.
 *
 * Uses `err.name` rather than `instanceof` because consumers and eve can end
 * up with different class identities after bundling.
 */
export function isGitHubCommandInputError(err: unknown): err is GitHubCommandInputError {
  return err instanceof Error && err.name === "GitHubCommandInputError";
}

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
    throw new GitHubCommandInputError(
      config.principalType === "user"
        ? "Set repository to owner/name or omit it; user tokens are not scoped to an owner."
        : "App tokens need repository set to an owner or owner/name.",
    );
  }
  const sandbox = await dependencies.getSandbox();
  let workingDirectory = resolveWorkingDirectory(sandbox, input.workingDirectory);
  if (argv[0] === "gh-signed-commit") {
    const repositoryRoot = await validateRepositoryRoot(sandbox, workingDirectory);
    if ("refused" in repositoryRoot) throw new GitHubCommandInputError(repositoryRoot.refused);
    workingDirectory = repositoryRoot.root;
  }
  const invocationId = crypto.randomUUID();
  const bodyFile = `/tmp/eve-git-body-${invocationId}.md`;
  const auth = dependencies.auth ?? null;
  const sender = dependencies.sender === undefined ? auth : dependencies.sender;
  // With user tokens, the command runs with the actor's own token, which eve hands out only once
  // they spoke last or approved the call. App tokens act for no one.
  const actingAs =
    config.principalType === "user" && input.actor !== undefined ? { as: input.actor } : undefined;
  let actor = auth;
  let userAuth: ToolAuthProvider | undefined;
  let token: string;
  if (config.principalType === "user") {
    if (!dependencies.getToken || !dependencies.requireAuth)
      throw new Error("User-scoped GitHub access requires ctx.getToken and ctx.requireAuth.");
    // Connect matches a user grant only to the exact authorization details it
    // was consented with, and repository details do not narrow user tokens.
    // One unscoped grant therefore covers every repository after one sign-in.
    userAuth = connectUserAuthorization(config.connector);
    const resolved = await dependencies.getToken(userAuth, actingAs);
    token = resolved.token;
    actor = actorOf(input.actor, auth, resolved.principal);
  } else {
    // Scope the installation token to the repository, or to the owner's
    // installation for owner-level commands such as `gh repo list <owner>`.
    const installation: {
      type: "github_app_installation";
      org: string;
      repositories?: string[];
      permissions?: string[];
    } = { type: "github_app_installation", org: owner! };
    if (name) installation.repositories = [name];
    if (config.permissions) installation.permissions = [...config.permissions];
    token = await (dependencies.getConnectToken ?? getToken)(config.connector, {
      authorizationDetails: [installation],
      subject: { type: "app" },
    });
  }
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(config.connector)}.`);
  const scope = repository ? ` on ${repository}` : owner ? ` for ${owner}` : "";
  // The declaration is model-controlled and cannot narrow a user token.
  // Never let it satisfy a repository allowlist for an unrestricted lease.
  const allowed =
    config.principalType === "user"
      ? await config.authorize({ argv, auth: actor, repository: null, token })
      : await config.authorize({ argv, auth, owner: owner!, repository, token });
  if (!allowed) {
    throw new Error(`The current caller is not authorized to run this command${scope}.`);
  }
  // An app token is nobody's own, so `authorize` is the only check on who asks for the command.
  // Another person's message can ask for it in the caller's turn, so they must pass it too. A
  // user token is its owner's own: `ctx.getToken` hands it out only once they spoke last or
  // approved the call.
  if (
    config.principalType !== "user" &&
    !isSamePerson(auth, sender) &&
    !(await config.authorize({ argv, auth: sender, owner: owner!, repository, token }))
  ) {
    throw new Error(
      `The person who spoke last in this turn is not authorized to run this command${scope}. Ask the person whose message started this turn to confirm it, and retry only after a reply from them that plainly confirms it.`,
    );
  }
  const coAuthor =
    config.attribution && dependencies.context && isAttributable(argv)
      ? await config.attribution(dependencies.context)
      : null;
  const commandArgv = coAuthor
    ? await attributeCommand(argv, coAuthorTrailer(coAuthor), sandbox, workingDirectory, bodyFile)
    : argv;
  if (!Array.isArray(commandArgv)) {
    throw new GitHubCommandInputError(
      `Pull request body file ${JSON.stringify(commandArgv.missingBodyFile)} not found.`,
    );
  }

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
      dependencies,
      { authorization, placeholder, placeholderAuthorization, token },
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
      config.broker,
    );
  } finally {
    await sandbox.removePath({ path: githubConfig, recursive: true, force: true });
    await sandbox.removePath({ path: bodyFile, force: true });
  }
  if (userAuth && result.exitCode !== 0 && GITHUB_UNAUTHORIZED.test(result.stderr)) {
    // GitHub rejected the caller's token: evict it and sign the caller in again.
    dependencies.requireAuth!(userAuth, actingAs);
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

/** The real credential and the placeholder a leased command sends in its place. */
interface LeaseCredential {
  readonly authorization: string;
  readonly placeholder: string;
  readonly placeholderAuthorization: string;
  readonly token: string;
}

async function withGitHubCredentialLease<T>(
  sandbox: SandboxSession,
  { sessionId, abortSignal }: Pick<GitHubShellDependencies, "sessionId" | "abortSignal">,
  credential: LeaseCredential,
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
    return await withSandboxLeaseLock(
      sandbox,
      credential.placeholder,
      () => leaseCredential(sandbox, credential, run, broker),
      {
        // Clears the policy only while this command still holds the lock, so a command whose
        // lock was broken as stale can't clear its successor's credential.
        cleanup: () => broker(sandbox, null),
        ...(abortSignal !== undefined && { signal: abortSignal }),
      },
    );
  } finally {
    release();
    if (leaseQueues.get(sessionId) === current) leaseQueues.delete(sessionId);
  }
}

/** Points the sandbox's network policy at `credential` for `run`; the lock's release clears it. */
async function leaseCredential<T>(
  sandbox: SandboxSession,
  credential: LeaseCredential,
  run: () => PromiseLike<T>,
  broker: GitHubConfig["broker"],
): Promise<T> {
  const api: GitHubLeaseRule[] = [
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
  ];
  await broker(sandbox, {
    "api.github.com": api,
    // `gh release upload` and `gh release create` with assets send files here.
    "uploads.github.com": api,
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
}

/**
 * The person a user-token command acts for, as `authorize` sees them: the caller, or the person
 * eve resolved for `actor`. Without one, the command fails rather than authorize a guess.
 */
function actorOf(
  actor: string | undefined,
  auth: SessionAuthContext | null,
  resolved: SessionAuthContext | undefined,
): SessionAuthContext | null {
  if (resolved !== undefined) return resolved;
  if (actor === undefined || auth?.principalId === actor) return auth;
  throw new Error(`eve didn't resolve who ${actor} is, so the command can't be checked for them.`);
}

/**
 * Whether two session identities are one person. Unauthenticated and anonymous identities are one
 * person. `personKey` matches eve's internal `principalOf` exactly, so this compares people as
 * every eve guard does; eve-git keeps its own copy because it may use only eve's public API.
 */
function isSamePerson(
  a: SessionAuthContext | null | undefined,
  b: SessionAuthContext | null | undefined,
): boolean {
  return personKey(a) === personKey(b);
}

function personKey(auth: SessionAuthContext | null | undefined): string {
  if (auth === null || auth === undefined || auth.principalType === "anonymous") return "anonymous";
  return JSON.stringify([
    auth.authenticator,
    auth.issuer ?? null,
    auth.principalType,
    auth.principalId,
  ]);
}

export function parseCommand(command: string): string[] {
  const value = command.trim();
  if (!value) throw new GitHubCommandInputError("GitHub command must not be empty.");
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
  if (escaped || quote) {
    throw new GitHubCommandInputError("GitHub command contains an unfinished quote or escape.");
  }
  if (started) argv.push(token);
  if (argv.length === 0) throw new GitHubCommandInputError("GitHub command must not be empty.");
  return argv;
}

function validateGitHubShellInput(input: GitHubShellInput): {
  argv: string[];
  target: ReturnType<typeof declaredTarget>;
} {
  const argv = parseCommand(input.command);
  if (!input.description.trim()) {
    throw new GitHubCommandInputError("description must describe the intended result.");
  }
  // The credential lease is wired only into these executables: gh reads the
  // placeholder GH_TOKEN and git sends the placeholder header.
  if (!EXECUTABLES.has(argv[0]!)) {
    throw new GitHubCommandInputError("GitHub commands must use gh, git, or gh-signed-commit.");
  }
  if (argv.length < 2) {
    throw new GitHubCommandInputError(`A ${argv[0]} subcommand or argument is required.`);
  }
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
  if (!match) {
    throw new GitHubCommandInputError(
      `Invalid GitHub repository or owner ${JSON.stringify(value)}.`,
    );
  }
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
    throw new GitHubCommandInputError(
      "GitHub command workingDirectory must stay inside the sandbox workspace.",
    );
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

function unsupportedSyntax(): GitHubCommandInputError {
  return new GitHubCommandInputError(
    "GitHub commands support argv syntax only, not pipes, redirects, substitutions, or shell operators.",
  );
}
