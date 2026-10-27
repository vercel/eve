import { createHash } from "node:crypto";

import type { SlackHandle } from "eve/channels/slack";
import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";

/**
 * Set to `false` to keep all Slack work in the thread. The agent then never
 * opens a code channel, and its instructions leave code channels out.
 */
export const CODE_CHANNELS = true;

/** What only the agent knows about its task, reported with `update_code_channel_status`. */
export interface CodeChannelStatus {
  readonly pullRequest?: {
    readonly number: number;
    readonly state: "draft" | "open" | "merged" | "closed";
    readonly url: string;
  };
  readonly tests?: "passing" | "failing" | "running";
}

export const codeChannelStatus = defineState<CodeChannelStatus>("code-channels.status", () => ({}));

/** What the code channel shows now, so a sync only calls Slack when something changed. */
interface Shown {
  readonly contextBar?: string;
  readonly diff?: string;
  readonly diffViewId?: string;
}

const shown = defineState<Shown>("code-channels.shown", () => ({}));

/** One repository under `/workspace/repos/` and its changes against its base branch. */
interface Repository {
  readonly base: string;
  readonly branch: string;
  readonly diff: string;
  readonly name: string;
  readonly pushed: boolean;
  readonly slug: string | undefined;
}

// Slack keeps at most one diff view per channel, up to 1,000,000 bytes.
const MAX_DIFF_BYTES = 1_000_000;
// Untracked files over this size are left out of the diff view.
const MAX_UNTRACKED_FILE_BYTES = 100_000;
const RECORD = "\x1e";
const SECTION = "\x1d";

// One sandbox round trip. First each repository's metadata line, then, under
// one byte cap for all of them, each diff against the merge base with the
// remote's default branch. Untracked files are included, except ones that
// look like secrets or are too large to review, since the diff view is posted
// to Slack.
const READ_WORKSPACE = `
repos=$(find /workspace/repos -mindepth 2 -maxdepth 3 -name .git -type d 2>/dev/null)
for git in $repos; do
  repo=\${git%/.git}
  cd "$repo" || continue
  base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  printf '${RECORD}%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$repo" "$(basename "$repo")" \\
    "$(git remote get-url origin 2>/dev/null | sed -E 's#//[^/@]*@#//#')" \\
    "$(git branch --show-current)" "\${base#origin/}" "$(git rev-parse --abbrev-ref @{u} 2>/dev/null)"
done
printf '${SECTION}'
for git in $repos; do
  repo=\${git%/.git}
  cd "$repo" || continue
  name=$(basename "$repo")
  base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  since=$(git merge-base HEAD "$base" 2>/dev/null || git rev-parse HEAD 2>/dev/null)
  printf '${RECORD}%s\\n' "$repo"
  {
    git diff --src-prefix="a/$name/" --dst-prefix="b/$name/" "$since"
    git ls-files --others --exclude-standard -z | xargs -0 -r sh -c '
      for file; do
        case "/$file" in
          */.env | */.env.* | */.npmrc | */.netrc | */id_rsa* | */id_ed25519* | *.pem | *.key | *.p12 | *.pfx) continue ;;
        esac
        [ "$(wc -c < "$file")" -le ${MAX_UNTRACKED_FILE_BYTES} ] || continue
        git diff --no-index --src-prefix="a/$0/" --dst-prefix="b/$0/" /dev/null "$file"
      done' "$name"
  } 2>/dev/null
done | head -c $((${MAX_DIFF_BYTES} + 1))
true
`;

async function readWorkspace(sandbox: SandboxSession): Promise<Repository[]> {
  const { stdout } = await sandbox.run({ command: READ_WORKSPACE });
  const section = stdout.indexOf(SECTION);
  const diffs = new Map<string, string>();
  for (const record of stdout
    .slice(section + 1)
    .split(RECORD)
    .slice(1)) {
    const newline = record.indexOf("\n");
    diffs.set(record.slice(0, newline), record.slice(newline + 1));
  }
  return stdout
    .slice(0, section)
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const [path = "", name = "", remote = "", branch = "", base = "", upstream = ""] = record
        .replace(/\n$/, "")
        .split("\t");
      return {
        base,
        branch,
        diff: diffs.get(path) ?? "",
        name,
        pushed: upstream.length > 0,
        // The script strips credentials from the remote; only the owner/name slug is kept.
        slug: /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1],
      };
    });
}

function contextBarItems(repository: Repository | undefined, status: CodeChannelStatus) {
  const items: Record<string, string>[] = [];
  if (repository !== undefined) {
    const repoUrl = repository.slug && `https://github.com/${repository.slug}`;
    items.push({
      icon: "folder",
      key: "repo",
      label: repository.slug ?? repository.name,
      ...(repoUrl && { url: repoUrl }),
    });
    if (repository.branch) {
      items.push({
        icon: "branch",
        key: "branch",
        label: repository.branch,
        ...(repoUrl &&
          repository.pushed && {
            url: `${repoUrl}/tree/${repository.branch.split("/").map(encodeURIComponent).join("/")}`,
          }),
      });
    }
    const files = repository.diff.match(/^diff --git /gm)?.length ?? 0;
    if (files > 0) {
      items.push({
        icon: "code",
        key: "changes",
        label: `${files} ${files === 1 ? "file" : "files"} changed`,
      });
    }
  }
  if (status.pullRequest) {
    const { number, state, url } = status.pullRequest;
    items.push({ icon: "hierarchy", key: "pr", label: `PR #${number} is ${state}`, url });
  }
  if (status.tests) {
    items.push({ icon: "terminal", key: "tests", label: `Tests ${status.tests}` });
  }
  return items;
}

// Cuts at a file boundary, so the view never shows half a hunk.
function truncateDiff(diff: string): string {
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return diff;
  const head = bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  const cut = head.lastIndexOf("\ndiff --git ");
  return cut < 0 ? "" : head.slice(0, cut + 1);
}

/**
 * Shows the agent's work in the code channel: the context bar with the
 * repository, branch, changes, pull request, and tests, and the diff view with
 * every change against the base branch. Calls Slack only for what changed.
 */
export async function syncCodeChannel(slack: SlackHandle, sandbox: SandboxSession): Promise<void> {
  const repositories = await readWorkspace(sandbox);
  const changed = repositories.filter((repository) => repository.diff.length > 0);
  const primary = changed[0] ?? repositories[0];

  const items = contextBarItems(primary, codeChannelStatus.get());
  const contextBar = fingerprint(items);
  if (contextBar !== shown.get().contextBar) {
    const response = await slack.request("agents.conversations.setProperties", {
      channel_id: slack.channelId,
      code_channel: { context_bar_items: items },
    });
    if (check("agents.conversations.setProperties", response)) {
      shown.update((current) => ({ ...current, contextBar }));
    }
  }

  const diff = truncateDiff(changed.map((repository) => repository.diff).join(""));
  const { diffViewId } = shown.get();
  // A clean workspace, such as after `git stash` or a reset, takes the diff view down.
  if (diff.length === 0 || primary === undefined) {
    if (diffViewId === undefined) return;
    const response = await slack.request("agents.conversations.removeView", {
      channel_id: slack.channelId,
      view_id: diffViewId,
    });
    if (check("agents.conversations.removeView", response) || response.error === "view_not_found") {
      shown.update(({ diff: _diff, diffViewId: _id, ...current }) => current);
    }
    return;
  }
  const diffFingerprint = fingerprint(diff);
  if (diffFingerprint === shown.get().diff) return;
  const response = await slack.request("agents.conversations.setView", {
    channel_id: slack.channelId,
    type: "diff",
    content: diff,
    ...(primary.base && { base_branch: primary.base }),
    ...(primary.branch && { head_branch: primary.branch }),
  });
  if (check("agents.conversations.setView", response)) {
    const viewId = typeof response.view_id === "string" ? response.view_id : undefined;
    shown.update((current) => ({ ...current, diff: diffFingerprint, diffViewId: viewId }));
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function check(method: string, response: { ok?: unknown; error?: unknown }): boolean {
  if (response.ok === true) return true;
  console.warn(`Slack ${method} failed: ${String(response.error)}`);
  return false;
}
