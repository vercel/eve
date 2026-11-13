/**
 * Consumer-facing Slack code channel renderer exported as `eve/extensions/code/slack`.
 *
 * Keeps a code channel's context bar and diff view in step with the coding
 * work in the session sandbox. It only observes: it reads settled tool calls
 * and runs read-only `git`, and never changes how the agent codes.
 *
 * Agents have no fixed checkout layout, so the repository comes from the call
 * that just settled (an `edit_file` or `write_file` path, a `gh` working
 * directory or clone, a `cd` or `git -C`), then the last repository shown,
 * then the most recently changed checkout under the workspace.
 */
import {
  defineSlackRenderer,
  setCodeChannelContextBar,
  setCodeChannelDiffView,
  SLACK_DIFF_VIEW_MAX_BYTES,
  type SlackCodeChannelContextBarItem,
  type SlackRenderer,
} from "eve/channels/slack";
import { call, type CallObservation } from "eve/events";
import type { SandboxSession } from "eve/sandbox";

export interface CodeChannelSurfacesOptions {
  /**
   * Tools whose settled calls refresh the context bar and diff view. Defaults
   * to `bash`, `edit_file`, `write_file`, and the `gh` tool of an
   * `eve/extensions/git` mount, whatever its namespace.
   */
  readonly syncAfter?: readonly string[];
}

/**
 * A Slack renderer that shows the repository, branch, changed files, and
 * pull request in a code channel's context bar, and every change against the
 * base branch in its diff view. Add it to `slackChannel({ renderers })`.
 * Outside code channels it only passes events on, and failures are logged
 * without affecting the turn.
 */
export function codeChannelSurfaces(options: CodeChannelSurfacesOptions = {}): SlackRenderer {
  const { syncAfter } = options;
  const syncs = syncAfter
    ? (name: string) => syncAfter.includes(name)
    : (name: string) => DEFAULT_SYNC_TOOLS.has(name) || isGhTool(name);
  return defineSlackRenderer({
    events: {
      async "call.settled"(event, ctx, next) {
        await next();
        if (ctx.channel.state.codeChannel !== true) return;
        const observed = call(ctx.view, event.data.callId);
        if (observed?.state !== "completed" || !syncs(observed.name)) return;
        try {
          await syncCodeChannel(ctx.channel, observed, await ctx.getSandbox());
        } catch (error) {
          console.warn("Could not update the code channel's context bar or diff view", error);
        }
      },
    },
  });
}

const DEFAULT_SYNC_TOOLS: ReadonlySet<string> = new Set(["bash", "edit_file", "write_file"]);

function isGhTool(name: string): boolean {
  return name === "gh" || name.endsWith("__gh");
}

type SurfaceChannel = Parameters<typeof setCodeChannelContextBar>[0];

/** What the code channel last showed, beside eve's own channel state. */
interface Shown {
  repository?: CheckoutSummary;
  pullRequest?: PullRequestSummary;
}

export interface CheckoutSummary {
  readonly root: string;
  /** `owner/name` of a GitHub `origin`; undefined for any other remote. */
  readonly slug?: string;
  readonly branch: string;
  /** The remote's default branch, without `origin/`; "" when unknown. */
  readonly base: string;
  /** Whether the branch is pushed to `origin` under its own name, so it can be linked. */
  readonly pushed: boolean;
  /** Undefined when the base is unknown, so committed work can't be counted. */
  readonly changedFiles?: number;
}

export interface PullRequestSummary {
  readonly url: string;
  readonly number: number;
}

interface Checkout extends CheckoutSummary {
  /** Undefined when the base is unknown. */
  readonly diff?: string;
}

async function syncCodeChannel(
  channel: SurfaceChannel,
  observed: CallObservation,
  sandbox: SandboxSession,
): Promise<void> {
  const state = channel.state as typeof channel.state & { codeChannelWork?: Shown };
  const shown = (state.codeChannelWork ??= {});

  const pullRequest = pullRequestFromCall(observed);
  if (pullRequest) shown.pullRequest = pullRequest;

  const previous = shown.repository?.root;
  let checkout = await readCheckout(sandbox, [
    ...repositoryHints(observed),
    ...(previous ? [previous] : []),
  ]);
  // A command that only visits a checkout with no known changes, such as
  // `cd other && ls`, doesn't replace the repository being worked on.
  if (checkout && !checkout.changedFiles && previous && checkout.root !== previous) {
    checkout = (await readCheckout(sandbox, [previous])) ?? checkout;
  }
  if (checkout) {
    const { diff: _diff, ...summary } = checkout;
    shown.repository = summary;
  }

  const items = contextBarItems(shown.repository, shown.pullRequest);
  if (items.length > 0) await setCodeChannelContextBar(channel, items);

  // Without a known base the diff can't be trusted, so the last view stays up.
  if (!checkout || checkout.diff === undefined) return;
  await setCodeChannelDiffView(channel, {
    content: checkout.diff,
    ...(checkout.base && { baseBranch: checkout.base }),
    ...(checkout.branch && { headBranch: checkout.branch }),
  });
}

/** Directories or files the settled call worked in, nearest first. */
export function repositoryHints(
  observed: Pick<CallObservation, "input" | "name" | "output">,
): string[] {
  const input = record(observed.input);
  const hints: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) hints.push(value.trim());
  };
  const command = typeof input?.["command"] === "string" ? input["command"] : "";
  if (observed.name === "edit_file") {
    add(record(observed.output)?.["path"] ?? input?.["path"]);
  } else if (observed.name === "write_file") {
    add(record(observed.output)?.["path"] ?? input?.["filePath"]);
  } else if (isGhTool(observed.name)) {
    add(input?.["workingDirectory"]);
    // `gh repo clone owner/name [directory]` creates the checkout the work continues in.
    const clone = /\bgh\s+repo\s+clone\s+(\S+)(?:\s+(?!-)(\S+))?/u.exec(command);
    if (clone)
      add(
        unquote(
          clone[2] ??
            clone[1]
              ?.split("/")
              .at(-1)
              ?.replace(/\.git$/u, ""),
        ),
      );
  }
  for (const path of commandDirectories(command)) add(path);
  return [...new Set(hints)];
}

/** Directories named by `cd <dir>` or `git -C <dir>` in a shell command. */
function commandDirectories(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(
    /(?:^|[;&|(]\s*|\s)(?:cd|git\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gu,
  )) {
    const path = unquote(match[1]);
    if (path && path !== "-" && !path.startsWith("$")) found.push(path);
  }
  return found;
}

/** The pull request a `gh pr create` printed. */
export function pullRequestFromCall(
  observed: Pick<CallObservation, "input" | "name" | "output">,
): PullRequestSummary | undefined {
  const command = record(observed.input)?.["command"];
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/u.test(command)) return undefined;
  const output = observed.output;
  const stdout = typeof output === "string" ? output : record(output)?.["stdout"];
  if (typeof stdout !== "string") return undefined;
  const match = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/u.exec(stdout);
  return match ? { url: match[0], number: Number(match[1]) } : undefined;
}

/** Repository, branch, changes, and pull request, as far as each is known. */
export function contextBarItems(
  repository: CheckoutSummary | undefined,
  pullRequest: PullRequestSummary | undefined,
): SlackCodeChannelContextBarItem[] {
  const items: SlackCodeChannelContextBarItem[] = [];
  const github = repository?.slug ? `https://github.com/${repository.slug}` : undefined;
  if (repository) {
    items.push({
      key: "repo",
      label: repository.slug ?? basename(repository.root),
      icon: "folder",
      ...(github && { url: github }),
    });
    if (repository.branch) {
      items.push({
        key: "branch",
        label: repository.branch,
        icon: "branch",
        ...(github &&
          repository.pushed && {
            url: `${github}/tree/${repository.branch.split("/").map(encodeURIComponent).join("/")}`,
          }),
      });
    }
    if (repository.changedFiles !== undefined) {
      items.push({
        key: "changes",
        label:
          repository.changedFiles === 0
            ? "No changes"
            : `${repository.changedFiles} ${repository.changedFiles === 1 ? "file" : "files"} changed`,
        icon: "code",
      });
    }
  }
  if (pullRequest) {
    items.push({
      key: "pr",
      label: `PR #${pullRequest.number}`,
      icon: "hierarchy",
      url: pullRequest.url,
    });
  }
  return items;
}

const SECTION = "\x1d";
// Untracked files over this size are left out of the diff view.
const MAX_UNTRACKED_FILE_BYTES = 100_000;

// Files that commonly hold credentials, left out of the diff view whether
// tracked or not, since the diff is posted to Slack.
const SECRET_GLOBS = [
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "id_rsa*",
  "id_ed25519*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
];
const SECRET_PATHSPECS = SECRET_GLOBS.map((glob) => `':(exclude,glob)**/${glob}'`).join(" ");
const SECRET_CASE_PATTERNS = SECRET_GLOBS.map((glob) => `*/${glob}`).join(" | ");

// One sandbox round trip. Picks the first candidate inside a git checkout, else
// the most recently changed checkout under the workspace, then prints its
// metadata and its diff against the merge base with the remote's default
// branch: committed and uncommitted changes, plus untracked files small enough
// to review, leaving out files that look like secrets. Credentials are
// stripped from the remote before it leaves the sandbox.
export const READ_CHECKOUT = `
pick=""
for p in "$@"; do
  d=$p
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ] && [ ! -d "$d" ]; do d=$(dirname "$d"); done
  [ -d "$d" ] || continue
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) && { pick=$top; break; }
done
if [ -z "$pick" ]; then
  pick=$(find . -maxdepth 4 \\( -name node_modules -o -name .eve \\) -prune -o -name .git -print 2>/dev/null |
    while read -r git; do
      repo=$(cd "\${git%/.git}" && pwd)
      [ -n "$(git -C "$repo" status --porcelain 2>/dev/null | head -n 1)" ] || continue
      printf '%s %s\\n' "$(stat -c %Y "$repo/.git/index" 2>/dev/null || echo 0)" "$repo"
    done | sort -rn | head -n 1 | cut -d' ' -f2-)
fi
[ -n "$pick" ] || exit 0
cd "$pick" || exit 0
since=""
for ref in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
  [ -n "$ref" ] && since=$(git merge-base HEAD "$ref" 2>/dev/null) && { base=$ref; break; }
done
# Without a base, committed work can't be told apart, so report nothing rather than a clean checkout.
[ -n "$since" ] || base=""
changed=$({ [ -n "$since" ] && git diff --name-only "$since" 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u | grep -c .)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$pick" \\
  "$(git remote get-url origin 2>/dev/null | sed -E 's#//[^/@]*@#//#')" \\
  "$(git branch --show-current 2>/dev/null)" "\${base#origin/}" \\
  "$(git rev-parse --abbrev-ref @{u} 2>/dev/null)" "$changed"
printf '${SECTION}'
[ -n "$since" ] || exit 0
{
  git diff --no-color --no-ext-diff "$since" -- . ${SECRET_PATHSPECS}
  git ls-files --others --exclude-standard -z | xargs -0 -r sh -c '
    for file; do
      case "/$file" in
        ${SECRET_CASE_PATTERNS}) continue ;;
      esac
      [ "$(wc -c < "$file")" -le ${MAX_UNTRACKED_FILE_BYTES} ] || continue
      git diff --no-color --no-index /dev/null "$file"
    done' sh
} 2>/dev/null | head -c $((${SLACK_DIFF_VIEW_MAX_BYTES} + 1))
true
`;

async function readCheckout(
  sandbox: Pick<SandboxSession, "run">,
  candidates: readonly string[],
): Promise<Checkout | undefined> {
  const args = candidates.map(shellQuote).join(" ");
  const { stdout, exitCode, stderr } = await sandbox.run({
    command: `sh -c ${shellQuote(READ_CHECKOUT)} sh ${args}`,
  });
  if (exitCode !== 0) {
    console.warn("Could not read the code channel checkout", {
      exitCode,
      stderr: stderr.slice(0, 500),
    });
    return undefined;
  }
  return parseCheckout(stdout);
}

export function parseCheckout(stdout: string): Checkout | undefined {
  const section = stdout.indexOf(SECTION);
  if (section < 0) return undefined;
  const [root = "", remote = "", branch = "", base = "", upstream = "", changed = "0"] = stdout
    .slice(0, section)
    .replace(/\n$/u, "")
    .split("\t");
  if (!root) return undefined;
  const slug = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(remote)?.[1];
  return {
    root,
    ...(slug && { slug }),
    branch,
    base,
    // `git checkout -b x origin/main` tracks origin/main before anything is pushed.
    pushed: branch !== "" && upstream === `origin/${branch}`,
    ...(base && {
      changedFiles: Number.parseInt(changed, 10) || 0,
      diff: stdout.slice(section + 1),
    }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unquote(value: string | undefined): string | undefined {
  return value?.replace(/^(["'])(.*)\1$/u, "$2");
}

function basename(path: string): string {
  return path.replace(/\/+$/u, "").split("/").at(-1) || path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
