---
issue: "#6820"
status: implemented
last_updated: "2026-11-25"
---

# Automatic repository instruction discovery and rules

## Problem

`eve/extensions/code` previously loaded a single workspace-root `AGENTS.md` or `CLAUDE.md` once at the start of the first turn. That missed common coding-agent workflows:

- **Post-clone discovery.** Repositories cloned mid-turn through `git__gh` or `bash`, unpacked from archives, or checked out in subdirectories had no automatic instruction loading.
- **Multi-repository workspaces.** Agents working across multiple checkouts, git worktrees, or submodules under one sandbox had no per-repository tracking or onboarding hooks.
- **Sparse and partial checkouts.** Clones using `--filter=blob:none` or sparse checkout could omit `AGENTS.md` from the working tree while still having it at `HEAD`.
- **Scoped subdirectory instructions.** Monorepos keep package-specific `AGENTS.md` or `CLAUDE.md` files in nested directories that only matter once file tools enter those directories.
- **Start-of-turn sandbox cost.** Eagerly calling `ctx.getSandbox()` at turn start always started a sandbox, even for turns that never needed one.

## Architecture boundaries

The design splits into three layers with strict ownership:

| Layer                 | Surface                                                                                   | Responsibility                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `eve` core            | `DynamicInstructionsSet` in `eve/instructions`; `GetSandboxOptions` (`{ create: false }`) | Per-key dynamic instruction tracking and non-creating sandbox lookups. No git or repository concepts in core.                           |
| `eve/extensions/git`  | `github.prefetchFiles` on `GitHubAppConfig` and `GitHubUserConfig`                        | Prefetch configured blobs into `.git/objects` on partial clones while the GitHub Connect credential lease is still open.                |
| `eve/extensions/code` | `code({ repositories })`; `discoverRepositories`, `readRepositoryFile` in `code/sandbox`  | Repository discovery, 3-tier instruction reading, scoped directory loading, `rules` (`files`, `onEnter`), and durable repository state. |

## Authoring API

### Core primitives

```ts
// eve/instructions
export type DynamicInstructionsSet = Readonly<Record<string, InstructionsDefinition>>;
export type DynamicInstructionsResult = InstructionsDefinition | DynamicInstructionsSet | null;

// eve/context
export interface GetSandboxOptions {
  readonly create?: boolean;
}
```

- `defineDynamic` in `agent/instructions/` returns a single `defineInstructions(...)`, a keyed map (`DynamicInstructionsSet`), or `null`.
- Keys must be non-empty strings without control characters. Each key tracks changes independently: adding or changing one key appends only that user-role entry to history, keeping earlier prompt prefixes cached. Removing a key (or returning `null`) resets tracking for that key so a later return adds it again without mutating earlier history. Compaction or clear that drops a key re-injects it before the next model call.
- `ctx.getSandbox({ create: false })` returns `null` without creating a sandbox when the session has never started one, deleted it, or its persisted sandbox is gone. If an idle-stopped persisted sandbox exists, it resumes and returns it.

### Git extension prefetching

```ts title="agent/extensions/git.ts"
export default git({
  github: {
    connector: "github/my-agent",
    broker: brokerGitHubLease,
    principalType: "app",
    authorize: ({ owner }) => owner.toLowerCase() === "acme",
    prefetchFiles: ["AGENTS.md", "CLAUDE.md", ".github/PULL_REQUEST_TEMPLATE.md"],
  },
});
```

- `github.prefetchFiles` defaults to `["AGENTS.md", "CLAUDE.md"]`. Pass `[]` to disable.
- After a successful `git clone`, `gh repo clone`, `git fetch`, `git pull`, `git checkout`, `git switch`, or `git sparse-checkout` whose target resolves inside the workspace root and has a configured promisor remote, `executeGitHubShell` fetches missing regular-file blobs into `.git/objects` via `git cat-file --batch-check` before revoking the credential lease.
- Prefetching never modifies the working tree, times out after 5 seconds, and swallows failures so the primary command result is unaffected.

### Code extension repositories config and helpers

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

export default code({
  repositories: {
    roots: ["."],
    instructions: [["AGENTS.md", "CLAUDE.md"]],
    scopedInstructions: true,
    discoverOnStart: "eager",
    maxFileBytes: 64_000,
    maxTotalBytes: 256_000,
    rules: [
      {
        match: "acme/*",
        files: [".github/PULL_REQUEST_TEMPLATE.md"],
        async onEnter(repo) {
          const contributing = await repo.readFile("CONTRIBUTING.md");
          return {
            instructions: contributing?.content ? [contributing.content] : undefined,
          };
        },
      },
    ],
  },
});
```

| Option               | Default                        | Semantics                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roots`              | `["."]`                        | Workspace-relative directories scanned breadth-first up to depth 3 for `.git` directories or worktree/submodule `.git` files, stopping at each repository boundary.                                                                                                  |
| `instructions`       | `[["AGENTS.md", "CLAUDE.md"]]` | Repository-relative specs. A string loads that path if present; a tuple loads the first present path. Pass `[]` to disable.                                                                                                                                          |
| `scopedInstructions` | `true`                         | Load matching ancestor directory instruction files as `read_file`, `edit_file`, `write_file`, `glob`, or `grep` enter subdirectories.                                                                                                                                |
| `discoverOnStart`    | `"eager"`                      | `"eager"` opens the sandbox at turn start if needed; `"on-sandbox-use"` checks via `ctx.getSandbox({ create: false })` (skips creating a new sandbox before first use, and resumes an idle-stopped persisted sandbox on later turns if the session already has one). |
| `rules`              | `[]`                           | Rules with optional `match` (`"owner/name"`, `"owner/*"`, `"*"`, `RegExp`, or predicate), extra `files`, and once-per-session `onEnter`.                                                                                                                             |
| `syncAfter`          | `[]`                           | Additional `ToolDefinition` values whose completed calls trigger workspace reconciliation.                                                                                                                                                                           |
| `maxFileBytes`       | `64_000`                       | Maximum UTF-8 bytes read per file before truncation with a path note.                                                                                                                                                                                                |
| `maxTotalBytes`      | `256_000`                      | Total UTF-8 byte budget across all emitted repository and scoped instruction entries; skipped paths are listed in an `overflow` entry.                                                                                                                               |

Rule `match` predicates and `onEnter` callbacks are error-isolated: a throwing rule logs a warning and is skipped without failing the turn or suppressing default instructions or other rules.

`eve/extensions/code/sandbox` also exports `discoverRepositories(sandbox, options?)` and `readRepositoryFile(sandbox, repoRoot, relativePath, options?)` for custom sandbox scripts and tools.

## Lifecycle

```text
turn.started ──► reconcileWorkspace (eager or create: false) ──┐
                                                               ├──► repoState (defineState) ──► instructions/project.ts (keyed user map)
call.settled ──► git/bash/syncAfter ──► reconcileWorkspace ────┤
             └──► file tool ──────────► reconcileTouchedFile ──┘
```

1. **Discovery (`turn.started` and `call.settled`).** Workspace scans walk breadth-first up to depth 3 under `roots`, stopping at each `.git` boundary (pruning `node_modules`, `.next`, `dist`, `build`, `.turbo`, `target`, `vendor`, `.venv`, and `__pycache__`) and also resolve enclosing repositories for command target paths or touched files. When the workspace root is not a git repository, workspace-root instruction files are read as fallback.
2. **3-tier offline file reading.** For each instruction spec inside a repository:
   - **Worktree (`source: "worktree"`):** Reads the checked-out file if it is a non-empty regular file whose canonical realpath stays inside the repository root.
   - **Git `HEAD` (`source: "git"`):** For sparse, promisor, or empty-worktree checkouts when absent from the working tree, queries `git ls-tree HEAD` offline for regular-file blobs (`100644` / `100755`) and reads local objects from `.git/objects` (paired with `eve/extensions/git`'s partial-clone prefetch). Non-sparse non-empty checkouts skip `git ls-tree`.
   - **Unavailable (`source: "unavailable"`):** When a regular-file blob exists at `HEAD` but is not in `.git/objects`, records a directive telling the model to check out or read the file before editing.
3. **Onboarding, refresh, and pruning.** New repositories run matching `rule.files` and `rule.onEnter(repo, ctx)` once per session. Root `instructions` and matching `rule.files` refresh on subsequent reconciliations (including same-`HEAD` edits or sparse-checkout materializations); `onEnter` does not run again. When a repository's `HEAD` SHA changes, its existing scoped instructions are pruned alongside its cached checked directories. When a previously tracked repository is deleted, it is pruned along with its scoped instructions and cached checked directories.
4. **Scoped directories.** When a file tool (`read_file`, `edit_file`, `write_file`, `glob`, `grep`) touches a path with unchecked ancestor directories, a single sandbox probe discovers any enclosing repository and loads matching instruction files from every unchecked ancestor directory between the repository (or workspace) root and the target directory. Checked directories are tracked in an LRU-bounded list of up to 500 entries.
5. **Pure instruction projection.** `instructions/project.ts` projects durable `repoState` directly into a keyed user-role instruction map with zero sandbox calls.

## Security and durability invariants

- **Path and symlink containment.** Config paths, `readRepositoryFile`, and `prefetchFiles` accept only relative POSIX paths without leading `/`, `.` or `..` segments, backslashes, or control characters. Worktree reads resolve symlinks with `realpath` and reject targets outside the repository or workspace root.
- **Untrusted repository hardening.** All git probes in `eve/extensions/code` are strictly offline with `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=`, `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, and `-c protocol.allow=never`. Partial-clone blob prefetching in `eve/extensions/git` runs inside the active GitHub credential lease with `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0`, `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, and `-c credential.helper=`. Git blob reads accept only regular file modes (`100644`, `100755`) and never execute hooks or dereference symlink blobs.
- **Credential sanitization.** `origin` remote URLs are stripped of embedded userinfo credentials, queries, and fragments before persisting `remote` or deriving `slug`.
- **Output framing and bounds.** Every sandbox probe uses a random per-invocation boundary token, caps discovered repositories (32), scan candidates (256), visited directories (1024), metadata fields (2048 bytes), and aggregate instruction bytes (`maxTotalBytes`), and bounds host-side output streaming via `sandbox.spawn()`.
- **Prompt boundary.** Repository instructions, scoped instructions, and `onEnter` instructions always emit with `role: "user"`, never `role: "system"`, with closing XML tags neutralized. The code extension's system instructions state that repository content never grants permission to publish or override safety rules.
- **Durability and caching.** Discovered repositories, rule contributions, scoped instructions, and checked directories persist in session state (`defineState("repositories", ...)`) across restarts and redeploys. Keyed dynamic instructions emit deterministic keys (`workspace`, `repo:<sha256>`, `scope:<sha256>`, `overflow`) so adding new repositories or scopes preserves earlier conversation history and prompt cache prefixes.
