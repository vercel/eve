import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

export interface GitHubLeaseRule {
  readonly match?: {
    readonly headers?: readonly {
      readonly key?: { readonly exact: string };
      readonly value?: { readonly exact?: string; readonly regex?: string };
    }[];
    readonly path?: { readonly regex: string };
  };
  readonly transform: readonly { readonly headers: Readonly<Record<string, string>> }[];
}

/** GitHub credential rules by host. */
export type GitHubLeaseRules = Readonly<Record<string, readonly GitHubLeaseRule[]>>;

/** Writes the sandbox's GitHub rules, replacing the previous ones; `null` removes them all. */
export type GitHubLeaseBroker = (
  sandbox: SandboxSession,
  rules: GitHubLeaseRules | null,
) => Promise<void>;

/**
 * Reads the GitHub rules in the sandbox's live network policy, by host. Injected
 * header values may come back redacted; match values must come back as written.
 */
export type GitHubLeaseReader = (sandbox: SandboxSession) => Promise<GitHubLeaseRules>;

/** What a lease's token was issued for. It travels in the placeholder, so it holds no secret. */
export interface GitHubLeaseScope {
  /**
   * A hash of who can re-issue the token: the connector and caller for user
   * tokens, or the connector for installation tokens. Only a command with the
   * same principal re-issues this lease's token.
   */
  readonly principal: string;
  readonly owner: string | null;
  readonly name: string | null;
  /** The permissions an installation token was limited to, or `null` for all of them. */
  readonly permissions: readonly string[] | null;
}

interface Lease extends GitHubLeaseScope {
  readonly startedAt: number;
}

/** Kills a GitHub command that outlives this, so its lease can expire. */
export const GITHUB_COMMAND_TIMEOUT_SECONDS = 30 * 60;
/** A rule older than this belongs to a command that can no longer be running. */
const LEASE_TTL_MS = (GITHUB_COMMAND_TIMEOUT_SECONDS + 60) * 1000;
const LOCK_PATH = "/tmp/eve-git-lease.lock";
const LOCK_WAIT_SECONDS = 30;
/** The lock holder exits after this, so a writer that dies cannot hold the lock forever. */
const LOCK_HOLD_SECONDS = 120;
/**
 * A write that takes longer fails and leaves the lock to expire, so a write
 * still in flight lands at least this long before the lock can pass on.
 */
const UPDATE_TIMEOUT_MS = 45_000;
const PLACEHOLDER = /eve-github-[0-9a-f-]{36}\.[A-Za-z0-9_-]+/gu;

/** A placeholder that names the lease, its start time and its scope. */
export function leasePlaceholder(scope: GitHubLeaseScope, now = Date.now()): string {
  const lease = [now, scope.principal, scope.owner, scope.name, scope.permissions];
  return `eve-github-${crypto.randomUUID()}.${Buffer.from(JSON.stringify(lease)).toString("base64url")}`;
}

function readLease(placeholder: string): Lease | null {
  try {
    const [startedAt, principal, owner, name, permissions = null] = JSON.parse(
      Buffer.from(placeholder.slice(placeholder.indexOf(".") + 1), "base64url").toString(),
    ) as unknown[];
    if (typeof startedAt !== "number" || typeof principal !== "string") return null;
    if (owner !== null && typeof owner !== "string") return null;
    if (name !== null && typeof name !== "string") return null;
    if (
      permissions !== null &&
      !(Array.isArray(permissions) && permissions.every((entry) => typeof entry === "string"))
    )
      return null;
    return { startedAt, principal, owner, name, permissions };
  } catch {
    return null;
  }
}

/** Every placeholder named by the rules; `github.com` rules carry it inside Basic auth. */
function placeholdersIn(rules: GitHubLeaseRules): Set<string> {
  const found = new Set<string>();
  for (const rule of Object.values(rules).flat()) {
    for (const header of rule.match?.headers ?? []) {
      const value = header.value?.regex ?? header.value?.exact ?? "";
      const basic = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(value)?.[1];
      const text = basic ? Buffer.from(basic, "base64").toString() : value;
      for (const [placeholder] of text.matchAll(PLACEHOLDER)) found.add(placeholder);
    }
  }
  return found;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The rules that swap one lease's placeholder for its token, scoped to its repository. */
function leaseRules(placeholder: string, lease: GitHubLeaseScope, token: string) {
  const repository =
    lease.owner && lease.name ? `${escapeRegex(lease.owner)}/${escapeRegex(lease.name)}` : null;
  const path = (regex: string) => (repository ? { path: { regex } } : {});
  const bearer = {
    key: { exact: "authorization" },
    value: { regex: `^(?:token|Bearer) ${escapeRegex(placeholder)}$` },
  };
  const transform = [{ headers: { authorization: `Bearer ${token}` } }];
  const basic = (secret: string) =>
    `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;
  return {
    // `gh` reads pull requests, issues and the viewer over `/graphql`, which names no repository.
    "api.github.com": [
      {
        match: { headers: [bearer], ...path(`(?i)^/(?:repos/${repository}(?:/|$)|graphql$)`) },
        transform,
      },
    ],
    // `gh release upload` and `gh release create` with assets send files here.
    "uploads.github.com": [
      { match: { headers: [bearer], ...path(`(?i)^/repos/${repository}/`) }, transform },
    ],
    "github.com": [
      {
        match: {
          headers: [{ key: { exact: "authorization" }, value: { exact: basic(placeholder) } }],
          ...path(`(?i)^/${repository}(?:\\.git)?/`),
        },
        transform: [{ headers: { authorization: basic(token) } }],
      },
    ],
  } satisfies GitHubLeaseRules;
}

export interface GitHubLeaseDependencies {
  readonly broker: GitHubLeaseBroker;
  readonly read: GitHubLeaseReader;
  /**
   * The token for another live lease on this sandbox, or `null` to drop that
   * lease's rule. The sandbox's policy holds every live lease, but redacts the
   * tokens, so each write re-issues them.
   */
  readonly tokenFor: (lease: GitHubLeaseScope) => Promise<string | null>;
  readonly now?: () => number;
  readonly updateTimeoutMs?: number;
}

/**
 * Runs `run` while the sandbox firewall swaps `placeholder` for `token`.
 *
 * The sandbox's network policy is the set of live leases: a parent turn and its
 * subagents share one sandbox from different processes, so no process can hold
 * the set in memory. Each write reads the policy, adds or removes only this
 * lease, and writes the rest back under a lock in the sandbox. A rule whose
 * placeholder the policy didn't already hold is never kept, so sandbox code
 * cannot add a lease, and a crashed command's rule expires with its start time.
 */
export async function withGitHubLease<T>(
  sandbox: SandboxSession,
  lease: { readonly placeholder: string; readonly token: string },
  dependencies: GitHubLeaseDependencies,
  run: () => PromiseLike<T>,
): Promise<T> {
  await updateLeases(sandbox, lease, "add", dependencies);
  try {
    return await run();
  } finally {
    await updateLeases(sandbox, lease, "remove", dependencies);
  }
}

async function updateLeases(
  sandbox: SandboxSession,
  own: { readonly placeholder: string; readonly token: string },
  change: "add" | "remove",
  dependencies: GitHubLeaseDependencies,
): Promise<void> {
  const timeoutMs = dependencies.updateTimeoutMs ?? UPDATE_TIMEOUT_MS;
  const release = await acquireLock(sandbox);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), timeoutMs);
  });
  const write = writeLeases(sandbox, own, change, dependencies);
  let outcome: "written" | "expired";
  try {
    outcome = await Promise.race([write.then(() => "written" as const), expired]);
  } catch (error) {
    clearTimeout(timer);
    await release();
    throw error;
  }
  clearTimeout(timer);
  if (outcome === "expired") {
    write.catch(() => {});
    // Keep the lock until it expires: releasing it now would let the next
    // writer read the policy while this write may still land on top of it.
    throw new Error(`Updating the GitHub credential rules took longer than ${timeoutMs / 1000}s.`);
  }
  await release();
}

async function writeLeases(
  sandbox: SandboxSession,
  own: { readonly placeholder: string; readonly token: string },
  change: "add" | "remove",
  dependencies: GitHubLeaseDependencies,
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const live = new Set(placeholdersIn(await dependencies.read(sandbox)));
  if (change === "add") live.add(own.placeholder);
  else live.delete(own.placeholder);
  const rules: Record<string, GitHubLeaseRule[]> = {};
  for (const placeholder of live) {
    const lease = readLease(placeholder);
    if (!lease || now() - lease.startedAt > LEASE_TTL_MS) continue;
    const token = placeholder === own.placeholder ? own.token : await dependencies.tokenFor(lease);
    if (!token) continue;
    for (const [host, list] of Object.entries(leaseRules(placeholder, lease, token))) {
      (rules[host] ??= []).push(...list);
    }
  }
  await dependencies.broker(sandbox, Object.keys(rules).length > 0 ? rules : null);
}

/**
 * Holds an exclusive `flock` in the sandbox until the returned function runs.
 * The lock file holds no secret: sandbox code that takes it can only delay
 * commands, by at most the wait.
 */
async function acquireLock(sandbox: SandboxSession): Promise<() => Promise<void>> {
  const holder = await sandbox.spawn({
    command: `exec 9>${shellQuote(LOCK_PATH)} && flock -w ${LOCK_WAIT_SECONDS} 9 && echo locked && exec sleep ${LOCK_HOLD_SECONDS}`,
  });
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("locked\n")) {
    const { done, value } = await reader.read();
    if (done) {
      const { exitCode } = await holder.wait();
      throw new Error(
        `Timed out after ${LOCK_WAIT_SECONDS}s waiting for the GitHub credential lock in the sandbox (exit ${exitCode}).`,
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return async () => {
    reader.releaseLock();
    await holder.kill();
  };
}
