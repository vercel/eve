import {
  getGitHubPullRequest,
  getGitHubRepository,
  type GitHubApiOptions,
  type GitHubPullRequestDetails,
} from "#public/channels/github/api.js";
import {
  resolveGitHubInstallationToken,
  type GitHubChannelCredentials,
} from "#public/channels/github/auth.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const DEFAULT_CHECKOUT_PATH = "/workspace";
const DEFAULT_CHECKOUT_DEPTH = 1;
const GITHUB_CHECKOUT_NETWORK_HINT =
  "Verify the GitHub App installation has access to this repository.";

/** Options for cloning a GitHub repository ref into the active sandbox. */
export interface GitHubCheckoutOptions {
  readonly depth?: number;
  readonly includeBase?: boolean;
  readonly mode?: "full" | "shallow";
  readonly path?: string;
  readonly ref?: string;
}

/** Result returned after a GitHub checkout completes. */
export interface GitHubCheckout {
  readonly baseRef: string | null;
  readonly path: string;
  readonly ref: string;
  readonly sha: string;
}

/** Internal descriptor used by channel-owned checkout paths. */
export interface GitHubCheckoutInput extends GitHubCheckoutOptions {
  readonly api?: GitHubApiOptions;
  readonly baseRef?: string | null;
  readonly baseSha?: string | null;
  readonly credentials?: GitHubChannelCredentials;
  readonly defaultBranch?: string | null;
  readonly headRef?: string | null;
  readonly headSha?: string | null;
  readonly installationId?: number | null;
  readonly owner?: string;
  readonly pullRequestNumber?: number | null;
  readonly repo?: string;
}

/**
 * Clones a described GitHub repository ref into the given sandbox.
 *
 * Runs on every turn via the channel's `turn.started` handler, which resolves
 * the session sandbox from its `ctx` and passes it in. The sandbox persists for
 * the session, so when the workspace is already at the target commit this is a
 * no-op probe — no token is minted and nothing is fetched.
 *
 * The installation token is brokered at the sandbox firewall
 * (`sandbox.setNetworkPolicy`) rather than embedded in the remote URL, so it
 * never enters the sandbox process. Requires a firewall-capable backend; the
 * local backend rejects `setNetworkPolicy`.
 *
 * Channel-internal; not part of the public GitHub channel API.
 */
export async function checkoutGitHubRepository(
  sandbox: SandboxSession,
  input: GitHubCheckoutInput,
): Promise<GitHubCheckout> {
  const descriptor = await resolveCheckoutDescriptor(input);
  const checkoutPath = sandbox.resolvePath(input.path ?? DEFAULT_CHECKOUT_PATH);
  const checkoutRef = resolveCheckoutRef(input.ref, descriptor);

  if (isFullSha(checkoutRef)) {
    const currentHead = await readCheckoutHead(sandbox, checkoutPath);
    if (currentHead === checkoutRef) {
      return {
        baseRef: descriptor.baseRef,
        path: checkoutPath,
        ref: checkoutRef,
        sha: currentHead,
      };
    }
  }

  const depth = normalizeCheckoutDepth(input.depth);
  const full = input.mode === "full";
  const fetchDepth = full ? "" : ` --depth ${depth}`;
  const token = await resolveGitHubInstallationToken({
    api: input.api,
    credentials: input.credentials,
    installationId: descriptor.installationId,
  });
  const remote = publicRemoteUrl({ owner: descriptor.owner, repo: descriptor.repo });
  const fetchedRef = isFullSha(checkoutRef) ? checkoutRef : "FETCH_HEAD";

  // Broker the installation token at the sandbox firewall: git fetches a clean
  // (token-free) URL and the platform injects `Authorization` on egress to
  // GitHub, so the token never enters the sandbox process. The `"*"` rule keeps
  // the agent's other egress open.
  await sandbox.setNetworkPolicy(buildBrokerNetworkPolicy(token));

  await runCheckoutCommand({
    command: `mkdir -p ${shellQuote(checkoutPath)}`,
    label: "create checkout directory",
    sandbox,
  });
  await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && git init`,
    label: "initialize git repository",
    sandbox,
  });
  await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && git remote remove origin >/dev/null 2>&1 || true`,
    label: "reset git remote",
    sandbox,
  });
  await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && git remote add origin ${shellQuote(remote)}`,
    label: "configure git remote",
    sandbox,
  });
  await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && GIT_TERMINAL_PROMPT=0 git fetch${fetchDepth} origin ${shellQuote(
      checkoutRef,
    )}`,
    label: "fetch GitHub ref",
    sandbox,
  });
  await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && git checkout --detach ${shellQuote(fetchedRef)}`,
    label: "checkout GitHub ref",
    sandbox,
  });
  if (input.includeBase === true && descriptor.baseSha !== null) {
    await runCheckoutCommand({
      command: `cd ${shellQuote(checkoutPath)} && GIT_TERMINAL_PROMPT=0 git fetch${fetchDepth} origin ${shellQuote(
        descriptor.baseSha,
      )}`,
      label: "fetch GitHub base ref",
      sandbox,
    });
  }

  const head = await runCheckoutCommand({
    command: `cd ${shellQuote(checkoutPath)} && git rev-parse HEAD`,
    label: "resolve checked out commit",
    sandbox,
  });
  const sha = head.stdout.trim() || descriptor.headSha || checkoutRef;
  return {
    baseRef: descriptor.baseRef,
    path: checkoutPath,
    ref: checkoutRef,
    sha,
  };
}

interface ResolvedCheckoutDescriptor {
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly defaultBranch: string | null;
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly installationId: number;
  readonly owner: string;
  readonly pullRequestNumber: number | null;
  readonly repo: string;
}

async function resolveCheckoutDescriptor(
  input: GitHubCheckoutInput,
): Promise<ResolvedCheckoutDescriptor> {
  const owner = readNonEmptyString(input.owner);
  const repo = readNonEmptyString(input.repo);
  if (owner === undefined || repo === undefined) {
    throw new Error("GitHub checkout requires a repository owner and name.");
  }
  if (input.installationId === undefined || input.installationId === null) {
    throw new Error("GitHub checkout requires a GitHub App installation id.");
  }

  const pullRequestNumber = input.pullRequestNumber ?? null;
  const explicitRef = readNonEmptyString(input.ref);
  let pullRequest: GitHubPullRequestDetails | null = null;
  if (
    pullRequestNumber !== null &&
    ((explicitRef === undefined &&
      (((input.headSha === undefined || input.headSha === null) &&
        (input.headRef === undefined || input.headRef === null)) ||
        input.defaultBranch === undefined ||
        input.defaultBranch === null)) ||
      (input.includeBase === true && (input.baseSha === undefined || input.baseSha === null)) ||
      (input.includeBase === true && (input.baseRef === undefined || input.baseRef === null)))
  ) {
    pullRequest = await getGitHubPullRequest({
      api: input.api,
      credentials: input.credentials,
      installationId: input.installationId,
      owner,
      pullRequestNumber,
      repo,
    });
  }

  const defaultBranch =
    readNonEmptyString(input.defaultBranch) ??
    pullRequest?.defaultBranch ??
    (await resolveRepositoryDefaultBranch(input, {
      owner,
      pullRequestNumber,
      repo,
    }));

  return {
    baseRef: input.baseRef ?? pullRequest?.base.ref ?? null,
    baseSha: input.baseSha ?? pullRequest?.base.sha ?? null,
    defaultBranch,
    headRef: input.headRef ?? pullRequest?.head.ref ?? null,
    headSha: input.headSha ?? pullRequest?.head.sha ?? null,
    installationId: input.installationId,
    owner,
    pullRequestNumber,
    repo,
  };
}

async function resolveRepositoryDefaultBranch(
  input: GitHubCheckoutInput,
  descriptor: {
    readonly owner: string;
    readonly pullRequestNumber: number | null;
    readonly repo: string;
  },
): Promise<string | null> {
  if (descriptor.pullRequestNumber !== null) return null;
  if (readNonEmptyString(input.ref) !== undefined) return null;
  if (readNonEmptyString(input.headSha) !== undefined) return null;
  if (readNonEmptyString(input.headRef) !== undefined) return null;
  return (
    (
      await getGitHubRepository({
        api: input.api,
        credentials: input.credentials,
        installationId: input.installationId ?? undefined,
        owner: descriptor.owner,
        repo: descriptor.repo,
      })
    ).defaultBranch ?? null
  );
}

function resolveCheckoutRef(
  explicitRef: string | undefined,
  descriptor: ResolvedCheckoutDescriptor,
): string {
  if (explicitRef !== undefined && explicitRef.trim().length > 0) return explicitRef.trim();
  if (descriptor.headSha !== null) return descriptor.headSha;
  if (descriptor.pullRequestNumber !== null)
    return `refs/pull/${descriptor.pullRequestNumber}/head`;
  if (descriptor.headRef !== null) return descriptor.headRef;
  if (descriptor.defaultBranch !== null) return descriptor.defaultBranch;
  throw new Error("GitHub checkout could not resolve a ref to fetch.");
}

async function readCheckoutHead(
  sandbox: SandboxSession,
  checkoutPath: string,
): Promise<string | null> {
  const result = await sandbox.run({
    command: `cd ${shellQuote(checkoutPath)} && git rev-parse HEAD 2>/dev/null`,
  });
  if (result.exitCode !== 0) return null;
  const head = String(result.stdout ?? "").trim();
  return isFullSha(head) ? head : null;
}

async function runCheckoutCommand(input: {
  readonly command: string;
  readonly label: string;
  readonly sandbox: SandboxSession;
}): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const result = await input.sandbox.run({ command: input.command });
  const stderr = String(result.stderr ?? "");
  const stdout = String(result.stdout ?? "");
  if (result.exitCode === 0) return { stderr, stdout };
  throw new Error(
    [
      `GitHub checkout failed during ${input.label} (exit ${result.exitCode}).`,
      stderr ? `stderr: ${stderr}` : undefined,
      stdout ? `stdout: ${stdout}` : undefined,
      GITHUB_CHECKOUT_NETWORK_HINT,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" "),
  );
}

function normalizeCheckoutDepth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHECKOUT_DEPTH;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("GitHub checkout depth must be a positive number.");
  }
  return Math.floor(value);
}

function publicRemoteUrl(input: { readonly owner: string; readonly repo: string }): string {
  return `https://github.com/${input.owner}/${input.repo}.git`;
}

/**
 * Builds the firewall policy that brokers the installation token onto git's
 * HTTPS egress. The header is injected at the fetch boundary (git uses Basic
 * auth with `x-access-token` as the username), so the clean remote URL carries
 * no secret. `codeload.github.com` is included because shallow fetches can
 * redirect there; `"*"` leaves all other egress untouched.
 */
function buildBrokerNetworkPolicy(token: string): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rule = [{ transform: [{ headers: { Authorization: authorization } }] }];
  return {
    allow: {
      "github.com": rule,
      "codeload.github.com": rule,
      "*": [],
    },
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isFullSha(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
