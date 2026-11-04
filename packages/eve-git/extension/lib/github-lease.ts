import { hostname } from "node:os";

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
/** Who holds the lock: the holder's sandbox pid, then its encoded `LockOwner`. */
const OWNER_PATH = "/tmp/eve-git-lease.owner";
const LOCK_WAIT_SECONDS = 30;
/** `flock` timed out; the holder printed the owner line. */
const LOCK_BUSY_EXIT = 75;
/**
 * How long after the invocation's deadline the lock outlives a writer that
 * never released it, for a policy write the API had already received.
 */
const LOCK_MARGIN_SECONDS = 30;
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
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
  /**
   * When the platform kills the process running this command, in epoch ms, or
   * `undefined` when it names none. Defaults to the Vercel Function
   * invocation's deadline.
   */
  readonly deadline?: () => number | undefined;
  /** Whether a process on this host is alive. Defaults to `process.kill(pid, 0)`. */
  readonly processAlive?: (pid: number) => boolean;
  /** Waits the lock margin before breaking a dead owner's lock. */
  readonly wait?: (ms: number) => Promise<void>;
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
  const now = dependencies.now ?? Date.now;
  const deadline = (dependencies.deadline ?? invocationDeadline)();
  // The API has no conditional write, so nothing can stop a late write from
  // landing. The lock therefore outlives this process: a write that never
  // settles keeps it until the platform kills the process, and only then can
  // the next writer read the policy.
  const release = await acquireLock(sandbox, lockSeconds(now(), deadline), dependencies);
  try {
    await writeLeases(sandbox, own, change, dependencies);
  } finally {
    await release();
  }
}

/**
 * How long the lock holder keeps the lock if this process never releases it,
 * or `null` to keep it until released: with no deadline nothing bounds how
 * long this process lives, so no expiry is safe.
 */
export function lockSeconds(now: number, deadline: number | undefined): number | null {
  if (deadline === undefined) return null;
  return Math.ceil(Math.max(0, (deadline - now) / 1000)) + LOCK_MARGIN_SECONDS;
}

function invocationDeadline(): number | undefined {
  const context = (
    globalThis as { [VERCEL_REQUEST_CONTEXT]?: { get?: () => { deadline?: unknown } | undefined } }
  )[VERCEL_REQUEST_CONTEXT]?.get?.();
  const deadline = context?.deadline;
  if (deadline === undefined) return undefined;
  const ms = new Date(deadline as string | number).getTime();
  return Number.isNaN(ms) ? undefined : ms;
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

/** The process that took a lock with no expiry. */
interface LockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly instance: string;
}

function readOwner(line: string): LockOwner | null {
  try {
    const owner = JSON.parse(
      Buffer.from(line.split(" ")[1] ?? "", "base64url").toString(),
    ) as Partial<LockOwner>;
    if (typeof owner.hostname !== "string" || typeof owner.instance !== "string") return null;
    if (typeof owner.pid !== "number") return null;
    return { hostname: owner.hostname, pid: owner.pid, instance: owner.instance };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Holds an exclusive `flock` in the sandbox until the returned function runs,
 * or for `seconds` if it never does. With `null`, nothing bounds the owner's
 * life, so the lock has no expiry: a waiter on the owner's host breaks it only
 * once the owner process is gone and the margin has passed. Any other waiter
 * fails, naming the owner. The lock files hold no secret: sandbox code that
 * takes the lock can only delay commands.
 */
async function acquireLock(
  sandbox: SandboxSession,
  seconds: number | null,
  dependencies: GitHubLeaseDependencies,
): Promise<() => Promise<void>> {
  const owner =
    seconds === null
      ? Buffer.from(
          JSON.stringify({ hostname: hostname(), pid: process.pid, instance: crypto.randomUUID() }),
        ).toString("base64url")
      : "-";
  let stale: string | null = null;
  for (;;) {
    const result = await tryLock(sandbox, seconds, owner, stale);
    if (typeof result === "function") return result;
    const holder = readOwner(result);
    const dead =
      stale === null &&
      holder !== null &&
      holder.hostname === hostname() &&
      !(dependencies.processAlive ?? processAlive)(holder.pid);
    if (!dead) {
      throw new Error(
        `Timed out after ${LOCK_WAIT_SECONDS}s waiting for the GitHub credential lock in the sandbox${
          holder
            ? `, held by process ${holder.pid} on ${holder.hostname} (instance ${holder.instance})`
            : ""
        }.`,
      );
    }
    await (dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
      LOCK_MARGIN_SECONDS * 1000,
    );
    stale = result;
  }
}

/** One `flock` attempt: the release function, or the owner line of whoever holds it. */
async function tryLock(
  sandbox: SandboxSession,
  seconds: number | null,
  owner: string,
  stale: string | null,
): Promise<(() => Promise<void>) | string> {
  const lock = shellQuote(LOCK_PATH);
  const ownerPath = shellQuote(OWNER_PATH);
  // Ends the dead owner's holder only if it still holds the lock.
  const breakStale = stale
    ? `if [ "$(cat ${ownerPath} 2>/dev/null)" = ${shellQuote(stale)} ]; then kill ${Number(stale.split(" ")[0])}; fi; `
    : "";
  const holder = await sandbox.spawn({
    command: `${breakStale}exec 9>${lock} && { flock -w ${LOCK_WAIT_SECONDS} 9 || { cat ${ownerPath} 2>/dev/null; exit ${LOCK_BUSY_EXIT}; }; } && echo "$$ ${owner}" > ${ownerPath} && echo locked && exec sleep ${seconds ?? "infinity"}`,
  });
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("locked\n")) {
    const { done, value } = await reader.read();
    if (done) {
      const { exitCode } = await holder.wait();
      if (exitCode === LOCK_BUSY_EXIT) return output.trim();
      throw new Error(
        `The GitHub credential lock holder exited with ${exitCode}: ${output.trim()}`,
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return async () => {
    reader.releaseLock();
    await holder.kill();
  };
}
