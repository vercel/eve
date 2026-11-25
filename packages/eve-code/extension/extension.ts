import { defineExtension } from "eve/extension";
import type { HookContext } from "eve/hooks";
import type { RuntimeSandboxSession, SandboxSession } from "eve/sandbox";
import type { SkillDefinition } from "eve/skills";
import type { ToolDefinition } from "eve/tools";
import { z } from "zod";

import { isValidRelativePath, isValidRootPath } from "./lib/repositories.ts";

/**
 * Callback that merges credential header rules, keyed by host, into the consumer's own sandbox network policy.
 * Pass it as `broker` when firewall delivery should not replace the sandbox's network policy itself.
 */
export type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

/**
 * A repository-relative instruction file path to load when present, or a fallback tuple where the first present file wins.
 */
export type RepositoryInstructionSpec = string | readonly string[];

/**
 * One instruction or repository file read from a git worktree, from `HEAD`, or recorded as unavailable in a sparse/partial checkout.
 */
export interface RepositoryInstructionFile {
  /** Canonical absolute path inside the sandbox. */
  readonly path: string;
  /** Repository-relative POSIX path. */
  readonly relativePath: string;
  /** Where the file was read from, or `"unavailable"` when it exists at `HEAD` but could not be fetched. */
  readonly source: "worktree" | "git" | "unavailable";
  /** File text content, or `null` when `source` is `"unavailable"`. */
  readonly content: string | null;
  /** Whether the file exceeded the configured byte cap and was truncated. */
  readonly truncated: boolean;
}

/**
 * Metadata and default instruction files discovered for a git repository in the sandbox.
 */
export interface DiscoveredRepository {
  /** Canonical realpath of the git worktree root. */
  readonly root: string;
  /** Repository slug (such as `"vercel/next.js"`) parsed from the sanitized `origin` remote, or `null`. */
  readonly slug: string | null;
  /** Sanitized `origin` remote URL with embedded credentials removed, or `null`. */
  readonly remote: string | null;
  /** Full `HEAD` commit SHA, or `null` when unborn. */
  readonly head: string | null;
  /** Active branch name, or `null` when detached or unborn. */
  readonly branch: string | null;
  /** Whether the repository uses sparse checkout or a promisor remote. */
  readonly sparse: boolean;
  /** Default instruction files loaded for the repository. */
  readonly instructions: readonly RepositoryInstructionFile[];
}

/**
 * A discovered repository passed to {@link RepositoryRule.onEnter}, with safe file access inside the repository root.
 */
export interface EnteredRepository extends DiscoveredRepository {
  /**
   * Reads a repository-relative file from the worktree with fallback to `HEAD:<relativePath>`,
   * enforcing path-traversal checks, symlink containment inside `root`, and the configured byte cap.
   */
  readFile(relativePath: string): Promise<RepositoryInstructionFile | null>;
}

/**
 * Runtime context passed to {@link RepositoryRule.onEnter}.
 */
export interface RepositoryRuleContext {
  /** Active sandbox session containing the entered repository. */
  readonly sandbox: RuntimeSandboxSession;
  /** Active session metadata from the triggering hook context. */
  readonly session: HookContext["session"];
  /** Channel metadata from the triggering hook context. */
  readonly channel: HookContext["channel"];
  /** Conversation metadata from the triggering hook context, when present. */
  readonly conversation?: HookContext["conversation"];
  /** Lifecycle event that discovered the repository. */
  readonly trigger: "turn.started" | "call.settled";
}

/**
 * Dynamic instructions and skills contributed when a {@link RepositoryRule} enters a repository.
 */
export interface RepositoryContribution {
  /** Additional user-role instructions injected for this repository in a dedicated `<repository_rules>` block. */
  readonly instructions?: string | readonly string[];
  /**
   * Dynamic skills registered while this repository is active in the session.
   * Skills are exposed under the `code__<name>` extension namespace; keys must match
   * `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,57}$/` and must not start with `eve__` (invalid keys are skipped with a warning).
   * When multiple repositories contribute the same skill name, the first entered repository wins.
   */
  readonly skills?: Readonly<Record<string, SkillDefinition>>;
}

/**
 * Declarative rule that matches discovered repositories and attaches extra files, instructions, or skills on entry.
 */
export interface RepositoryRule {
  /**
   * Repository matcher: `"owner/name"` exact case-insensitive slug match, `"owner/*"` wildcard prefix match,
   * a `RegExp` tested against `slug` or `root`, or a predicate. Omit to match every discovered repository.
   */
  readonly match?: string | RegExp | ((repo: DiscoveredRepository) => boolean);
  /** Extra repository-relative instruction file specs to load for matching repositories. */
  readonly files?: readonly RepositoryInstructionSpec[];
  /** Callback invoked once per session when a matching repository is first entered. */
  readonly onEnter?: (
    repo: EnteredRepository,
    ctx: RepositoryRuleContext,
  ) => void | RepositoryContribution | Promise<void | RepositoryContribution>;
}

/**
 * Configuration for repository discovery, instruction loading, and per-repository lifecycle hooks.
 */
export interface RepositoriesConfig {
  /** Workspace-relative directories scanned (up to depth 3) for repositories. Defaults to `["."]`. */
  readonly roots?: readonly string[];
  /** Default instruction file specs loaded for each repository and non-git workspace root. Defaults to `[["AGENTS.md", "CLAUDE.md"]]`; pass `[]` to disable. */
  readonly instructions?: readonly RepositoryInstructionSpec[];
  /** Whether to load nested directory `AGENTS.md` / `CLAUDE.md` files as files in subdirectories are touched. Defaults to `true`. */
  readonly scopedInstructions?: boolean;
  /** When to run start-of-turn repository discovery: `"eager"` (default) opens the sandbox; `"on-sandbox-use"` checks via `ctx.getSandbox({ create: false })`, skipping sandbox creation before first use and resuming an idle-stopped persisted sandbox on later turns if the session already has one. */
  readonly discoverOnStart?: "eager" | "on-sandbox-use";
  /** Rules applied to matching repositories when discovered. */
  readonly rules?: readonly RepositoryRule[];
  /** Additional tool definitions whose completed calls trigger repository reconciliation. */
  readonly syncAfter?: readonly ToolDefinition<any, any>[];
  /** Maximum UTF-8 bytes read per instruction file before truncation. Defaults to `64_000`. */
  readonly maxFileBytes?: number;
  /** Maximum total UTF-8 bytes across emitted repository and scoped instructions. Defaults to `256_000`. */
  readonly maxTotalBytes?: number;
}

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const delivery = z.enum(["firewall", "command"]).default("firewall");

const relativePathSchema = z
  .string()
  .refine(
    isValidRelativePath,
    "Paths must be relative POSIX paths without leading `/`, `.` or `..` segments, backslashes, or control characters.",
  );

const rootPathSchema = z
  .string()
  .refine(
    isValidRootPath,
    'Root paths must be `"."` or relative POSIX paths without leading `/`, `.` or `..` segments, backslashes, or control characters.',
  );

const instructionSpecSchema = z.union([
  relativePathSchema,
  z.array(relativePathSchema).min(1).readonly(),
]);

const repositoryRuleSchema = z.strictObject({
  match: z
    .union([z.string().min(1), z.instanceof(RegExp), fn<(repo: DiscoveredRepository) => boolean>()])
    .optional(),
  files: z.array(instructionSpecSchema).readonly().optional(),
  onEnter: fn<NonNullable<RepositoryRule["onEnter"]>>().optional(),
});

const repositoriesConfigSchema = z.strictObject({
  roots: z.array(rootPathSchema).readonly().optional(),
  instructions: z.array(instructionSpecSchema).readonly().optional(),
  scopedInstructions: z.boolean().optional(),
  discoverOnStart: z.enum(["eager", "on-sandbox-use"]).optional(),
  rules: z.array(repositoryRuleSchema).readonly().optional(),
  syncAfter: z
    .array(
      z.custom<ToolDefinition<any, any>>((value) => typeof value === "object" && value !== null),
    )
    .readonly()
    .optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxTotalBytes: z.number().int().positive().optional(),
});

function removedWorkerMessage(keys: readonly string[]): string | undefined {
  if (!keys.includes("worker")) return undefined;
  const others = keys.filter((key) => key !== "worker");
  const also =
    others.length === 0
      ? ""
      : ` Also unrecognized: ${others.map((key) => JSON.stringify(key)).join(", ")}.`;
  return `eve-code no longer ships a worker subagent; delegate with the built-in \`agent\` tool and remove the \`worker\` option.${also}`;
}

/**
 * Adds coding support to an agent: coding instructions for eve's file tools, repository and workspace `AGENTS.md` or `CLAUDE.md` lifecycle instructions, investigation and review skills, and sandbox tooling.
 * Set `vercel` to broker Connect-backed Vercel credentials into the sandbox before each turn, and `repositories` to customize discovery, rules, and instruction limits.
 */
export default defineExtension({
  config: z.strictObject(
    {
      vercel: z
        .object({
          connector: z.string().min(1),
          delivery,
        })
        .optional(),
      broker: fn<CredentialPolicyBroker>().optional(),
      repositories: repositoriesConfigSchema.optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys" ? removedWorkerMessage(issue.keys) : undefined,
    },
  ),
});
