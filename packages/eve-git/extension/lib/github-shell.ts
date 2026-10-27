import { posix } from "node:path";
import { getToken } from "@vercel/connect";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";

import {
  attributeCommand,
  coAuthorTrailer,
  isAttributable,
  type GitHubCoAuthor,
} from "./attribution.ts";
import { validateRepositoryRoot } from "./repository-root.ts";
import { shellQuote } from "./shell.ts";
import { GITHUB_TOOLING_PATHS } from "./tooling.ts";

export type { GitHubCoAuthor } from "./attribution.ts";

export interface GitHubPermission {
  readonly access: "write";
  readonly provider: "github";
  readonly repositories: readonly string[];
}

export interface GitHubShellInput {
  readonly command: string;
  readonly description: string;
  readonly permissions: readonly GitHubPermission[];
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

export interface GitHubConfig {
  /**
   * Resolves who the current turn publishes for. When it returns a person,
   * `gh-signed-commit` messages and `gh pr create` bodies end with their
   * `Co-authored-by` trailer. Return `null` to publish without one. It
   * receives the `gh` tool's context, so `ctx.getToken` can resolve the
   * requester's linked accounts.
   */
  readonly attribution?: GitHubAttribution;
  readonly authorize?: GitHubAuthorize;
  readonly broker: (
    sandbox: SandboxSession,
    rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
  ) => Promise<void>;
  readonly connector: string;
  readonly org: string;
}

/** What an `authorize` callback sees before a `gh` command runs. */
export interface GitHubAuthorizeRequest {
  /** The session's current caller, or `null` when the session has none. */
  readonly auth: SessionAuthContext | null;
  /** The `owner/name` repository the command declared. */
  readonly repository: string;
  /** The repository-scoped GitHub App token minted for this command, for API lookups. */
  readonly token: string;
}

/** Decides whether the session's caller may run a `gh` command against one repository. */
export type GitHubAuthorize = (request: GitHubAuthorizeRequest) => boolean | Promise<boolean>;

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
        repositories: string[];
      }[];
      subject: { type: "app" };
    },
  ) => Promise<string>;
  readonly getSandbox: () => Promise<SandboxSession>;
  /** Serializes credential leases per eve session; every `ctx.getSandbox()` call returns a new handle. */
  readonly sessionId: string;
}

type GitHubCommandDenialCode =
  | "brace_expansion"
  | "cd"
  | "chain"
  | "env_assignment"
  | "gh_subcommand"
  | "git_option"
  | "git_remote"
  | "git_subcommand"
  | "heredoc"
  | "invalid_input"
  | "line_continuation"
  | "pipe"
  | "program"
  | "redirect"
  | "substitution"
  | "subshell"
  | "unterminated_quote"
  | "variable";

class GitHubCommandError extends Error {
  readonly code: GitHubCommandDenialCode;

  constructor(code: GitHubCommandDenialCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface ShellSyntax {
  readonly code: Extract<
    GitHubCommandDenialCode,
    | "brace_expansion"
    | "chain"
    | "heredoc"
    | "pipe"
    | "redirect"
    | "subshell"
    | "substitution"
    | "variable"
  >;
  readonly token: string;
  /** Replaces the default fix for `code`. */
  readonly fix?: string;
}

const MAX_OUTPUT_BYTES = 100_000;
const leaseQueues = new Map<string, Promise<void>>();
const ALLOWED_GIT_REMOTE_COMMANDS = new Set(["fetch", "ls-remote", "pull", "push"]);
const NO_SHELL = "GitHub commands run without a shell";
const GIT_REMOTE_COMMANDS = "Authenticated git supports fetch, ls-remote, pull, and push";
const ARITHMETIC_FIX = "is not evaluated. Write the computed value, or write \\$ for a literal $.";
const QUOTING_FIX =
  "quoting is not interpreted. Use plain single or double quotes, or write \\$ for a literal $.";
const LITERAL_DOLLAR: ShellSyntax = {
  code: "variable",
  token: "$",
  fix: "must be in single quotes. Put the text in single quotes, such as 'costs 5$'.",
};
const BACKTICK: ShellSyntax = {
  code: "substitution",
  token: "`",
  fix: "must be in single quotes. Put literal backticks in single quotes or a --body-file, or run the inner command separately and use its output.",
};
const SHELL_SYNTAX_FIXES: Record<ShellSyntax["code"], (token: string) => string> = {
  brace_expansion: () =>
    "must be quoted. Quote literal braces, such as 'repos/{owner}/{repo}', and write each argument of a brace list out.",
  chain: () => "cannot chain commands. Send each command in its own call.",
  heredoc: () =>
    "cannot start a heredoc. Write the text to a file and pass it with --body-file, or --input for gh api.",
  pipe: () =>
    "cannot pipe output. Filter it with --jq or --template, or process it in a separate call.",
  redirect: () =>
    "cannot redirect. The tool returns stdout and stderr; read files with flags such as --body-file or --input.",
  subshell: () => 'must be quoted. Quote the text, such as "fix(git): title".',
  substitution: () =>
    "is not expanded. Run the inner command separately and use its output, or put literal text in single quotes or a --body-file.",
  variable: (token) =>
    `is not expanded. Write the value itself, or write \\${token} to send it literally.`,
};
const GIT_OPTION_FIXES: Readonly<Record<string, string>> = {
  "-c": " Set repository configuration with git config in bash, and send the command without -c.",
  "--no-pager": " Drop it: the tool never pages output.",
  "-P": " Drop it: the tool never pages output.",
};

/** Why the `gh` tool refuses `input`, with a stable reason code, or `undefined` when it can run. */
export function githubCommandDenial(input: GitHubShellInput) {
  try {
    validateGitHubShellInput(input);
    return undefined;
  } catch (error) {
    const code: GitHubCommandDenialCode =
      error instanceof GitHubCommandError ? error.code : "invalid_input";
    return { code, reason: error instanceof Error ? error.message : "Invalid GitHub command." };
  }
}

export function githubShellApproval(input: GitHubShellInput | undefined) {
  if (!input) return "not-applicable" as const;
  const denial = githubCommandDenial(input);
  return denial ? { type: "denied" as const, reason: denial.reason } : ("not-applicable" as const);
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
  const declaredRepositories = input.permissions[0]!.repositories;
  const remoteRepository = await assertCommandTargets(
    argv,
    declaredRepositories,
    workingDirectory,
    sandbox,
  );
  const invocationId = crypto.randomUUID();
  const bodyFile = `/tmp/eve-git-body-${invocationId}.md`;
  const repositories = repositoryNames(declaredRepositories, config.org);
  const tokenParams: Parameters<NonNullable<GitHubShellDependencies["getConnectToken"]>>[1] = {
    authorizationDetails: [{ type: "github_app_installation", org: config.org, repositories }],
    subject: { type: "app" },
  };
  const token = await (dependencies.getConnectToken ?? getToken)(config.connector, tokenParams);
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(config.connector)}.`);
  const repository = declaredRepositories[0]!;
  if (
    config.authorize &&
    !(await config.authorize({ auth: dependencies.auth ?? null, repository, token }))
  ) {
    throw new Error(`The current caller is not authorized to access ${repository}.`);
  }
  const coAuthor =
    config.attribution && dependencies.context && isAttributable(argv)
      ? await config.attribution(dependencies.context)
      : null;
  const commandArgv = coAuthor
    ? await attributeCommand(argv, coAuthorTrailer(coAuthor), sandbox, workingDirectory, bodyFile)
    : argv;

  const executable = executablePath(commandArgv[0]!);
  const executionArguments = remoteRepository
    ? [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        commandArgv[1]!,
        `https://github.com/${remoteRepository}.git`,
        ...commandArgv.slice(3),
      ]
    : commandArgv.slice(1);
  const command = `cd ${shellQuote(workingDirectory)} && exec ${shellQuote(executable)} ${executionArguments
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
    await sandbox.removePath({ path: bodyFile, force: true });
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
  if (!value) throw new GitHubCommandError("invalid_input", "GitHub command must not be empty.");
  if (value.includes("\0")) {
    throw new GitHubCommandError("invalid_input", "GitHub command contains a NUL character.");
  }
  const argv: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let quoteStart = 0;
  let escaped = false;
  let started = false;
  let refused: GitHubCommandError | undefined;
  let heredoc = false;
  const refuse = (syntax: ShellSyntax | undefined) => {
    if (!syntax) return;
    refused ??= shellSyntaxError(started ? [...argv, token] : argv, syntax);
    // Quotes inside $'…' follow escape rules the parser does not model.
    if (syntax.token === "$'") throw refused;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      if (character === "\n") {
        refused ??= new GitHubCommandError(
          "line_continuation",
          `${NO_SHELL}, so a "\\" at the end of a line cannot continue it. Put the whole command on one line.`,
        );
      }
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
    if (character === "$") {
      refuse(expansionAt(value, index, quote === "double") ?? LITERAL_DOLLAR);
    } else if (character === "`") {
      refuse(BACKTICK);
    } else if (quote === null && character === "\n" && heredoc) {
      throw refused!;
    } else if (quote === null) {
      const operator = operatorAt(value, index);
      refuse(operator);
      if (operator?.token === "<<") heredoc = true;
      if (operator) index += operator.token.length - 1;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      quoteStart = index;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (quote) throw unterminatedQuoteError(value, quote, quoteStart);
  if (refused) throw refused;
  if (escaped) {
    throw new GitHubCommandError(
      "unterminated_quote",
      'GitHub command ends with an unfinished "\\" escape. Remove it, or write "\\\\" for a literal backslash.',
    );
  }
  if (started) argv.push(token);
  if (argv.length === 0) {
    throw new GitHubCommandError("invalid_input", "GitHub command must not be empty.");
  }
  return argv;
}

/** The control or redirection operator bash reads at `index` outside quotes. */
function operatorAt(value: string, index: number): ShellSyntax | undefined {
  const pair = value.slice(index, index + 2);
  if (pair === "&&" || pair === "||") return { code: "chain", token: pair };
  if (pair === "<(" || pair === ">(") return { code: "substitution", token: pair };
  if (value.startsWith("<<<", index)) return { code: "heredoc", token: "<<<" };
  if (pair === "<<") return { code: "heredoc", token: pair };
  if (pair === "&>") return { code: "redirect", token: pair };
  const character = value[index]!;
  if (character === "|") return { code: "pipe", token: character };
  if (character === "&" || character === ";" || character === "\n") {
    return { code: "chain", token: character };
  }
  if (character === "<" || character === ">") return { code: "redirect", token: character };
  if (character === "{" || character === "}") return { code: "brace_expansion", token: character };
  if (character === "(" || character === ")") return { code: "subshell", token: character };
  return undefined;
}

/** The expansion bash performs at the `$` at `index`; bash leaves any other `$` literal. */
function expansionAt(value: string, index: number, quoted: boolean): ShellSyntax | undefined {
  const next = value[index + 1];
  if (next === "(") {
    return value[index + 2] === "("
      ? { code: "substitution", token: "$((", fix: ARITHMETIC_FIX }
      : { code: "substitution", token: "$(" };
  }
  if (next === "[") return { code: "substitution", token: "$[", fix: ARITHMETIC_FIX };
  if (!quoted && (next === "'" || next === '"')) {
    return { code: "substitution", token: `$${next}`, fix: QUOTING_FIX };
  }
  if (next === "{") return { code: "variable", token: "${" };
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9*@#?!$-])/u.exec(value.slice(index + 1));
  return name ? { code: "variable", token: `$${name[0]}` } : undefined;
}

function shellSyntaxError(words: readonly string[], syntax: ShellSyntax): GitHubCommandError {
  if (words[0] === "cd") return changeDirectoryError(words[1]);
  return new GitHubCommandError(
    syntax.code,
    `${NO_SHELL}, so ${JSON.stringify(syntax.token)} ${syntax.fix ?? SHELL_SYNTAX_FIXES[syntax.code](syntax.token)}`,
  );
}

function changeDirectoryError(directory: string | undefined): GitHubCommandError {
  const target = directory ? ` to ${JSON.stringify(directory)}` : "";
  return new GitHubCommandError(
    "cd",
    `${NO_SHELL}, so "cd" cannot change directory. Set the workingDirectory parameter${target} and send only the GitHub command.`,
  );
}

function unterminatedQuoteError(
  value: string,
  quote: "single" | "double",
  start: number,
): GitHubCommandError {
  const near = JSON.stringify(value.slice(Math.max(0, start - 20), start + 20));
  return new GitHubCommandError(
    "unterminated_quote",
    quote === "single"
      ? `GitHub command has an unterminated ' quote near ${near}. An apostrophe ends single-quoted text, so put that text in double quotes or pass it with --body-file.`
      : `GitHub command has an unterminated " quote near ${near}. Escape literal double quotes as \\", or pass long text with --body-file.`,
  );
}

function gitSubcommandError(subcommand: string | undefined, value: string | undefined) {
  if (subcommand === undefined) {
    return new GitHubCommandError("git_subcommand", `${GIT_REMOTE_COMMANDS}; name one after git.`);
  }
  if (subcommand.startsWith("-")) {
    const fix =
      subcommand === "-C"
        ? ` Set the workingDirectory parameter${value ? ` to ${JSON.stringify(value)}` : ""}.`
        : (GIT_OPTION_FIXES[subcommand] ?? " Put options after the subcommand.");
    return new GitHubCommandError(
      "git_option",
      `${GIT_REMOTE_COMMANDS} as its first argument, and ${JSON.stringify(subcommand)} is not a subcommand.${fix}`,
    );
  }
  if (subcommand === "clone") {
    return new GitHubCommandError(
      "git_subcommand",
      `${GIT_REMOTE_COMMANDS}; clone with gh repo clone owner/name.`,
    );
  }
  return new GitHubCommandError(
    "git_subcommand",
    `${JSON.stringify(`git ${subcommand}`)} is not an authenticated git command. ${GIT_REMOTE_COMMANDS}; run other git commands with bash.`,
  );
}

function gitRemoteError(subcommand: string, value: string | undefined): GitHubCommandError {
  const example = `git ${subcommand} origin <ref>`;
  return new GitHubCommandError(
    "git_remote",
    value?.startsWith("-")
      ? `Authenticated git needs origin right after the subcommand. Put ${JSON.stringify(value)} after the remote and refs, such as ${example} ${value}.`
      : `Authenticated git runs only against origin, right after the subcommand, such as ${example}.`,
  );
}

function validateGitHubShellInput(input: GitHubShellInput): string[] {
  const argv = parseCommand(input.command);
  const permission = input.permissions[0];
  if (input.permissions.length !== 1 || permission?.provider !== "github") {
    throw new GitHubCommandError("invalid_input", "Exactly one GitHub permission is required.");
  }
  if (permission.access !== "write") {
    throw new GitHubCommandError(
      "invalid_input",
      "GitHub App commands require explicit write-capable access.",
    );
  }
  if (!input.description.trim()) {
    throw new GitHubCommandError("invalid_input", "description must describe the intended result.");
  }
  const [executable, subcommand, value] = argv as [string, ...string[]];
  if (executable === "gh") {
    if (!subcommand) {
      throw new GitHubCommandError("gh_subcommand", "Name a gh subcommand, such as gh pr view.");
    }
  } else if (executable === "git") {
    if (!subcommand || !ALLOWED_GIT_REMOTE_COMMANDS.has(subcommand)) {
      throw gitSubcommandError(subcommand, value);
    }
    if (value !== "origin") throw gitRemoteError(subcommand, value);
  } else if (executable === "cd") {
    throw changeDirectoryError(subcommand);
  } else if (executable === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)) {
    const assignment = executable === "env" ? executable : executable.split("=")[0] + "=";
    throw new GitHubCommandError(
      "env_assignment",
      `${NO_SHELL}, so ${JSON.stringify(assignment)} cannot set the environment. Start with gh, git, or gh-signed-commit and pass settings as flags such as --repo; the tool supplies credentials.`,
    );
  } else if (executable !== "gh-signed-commit") {
    throw new GitHubCommandError(
      "program",
      `${JSON.stringify(executable)} is not a GitHub command. Start with gh, git, or gh-signed-commit, and run other programs with bash.`,
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
