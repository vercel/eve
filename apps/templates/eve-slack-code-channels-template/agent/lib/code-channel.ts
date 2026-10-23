import { createHash } from "node:crypto";

import type { SlackHandle } from "eve/channels/slack";
import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";

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
const RECORD = "\x1e";

// One sandbox round trip: each repository's metadata line, then its diff against
// the merge base with the remote's default branch, untracked files included.
const READ_WORKSPACE = `
for git in $(find /workspace/repos -mindepth 2 -maxdepth 3 -name .git -type d 2>/dev/null); do
  repo=\${git%/.git}
  cd "$repo" || continue
  name=$(basename "$repo")
  base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  since=$(git merge-base HEAD "$base" 2>/dev/null || git rev-parse HEAD 2>/dev/null)
  printf '${RECORD}%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$(git remote get-url origin 2>/dev/null | sed -E 's#//[^/@]*@#//#')" \\
    "$(git branch --show-current)" "\${base#origin/}" "$(git rev-parse --abbrev-ref @{u} 2>/dev/null)"
  {
    git diff --src-prefix="a/$name/" --dst-prefix="b/$name/" "$since"
    git ls-files --others --exclude-standard -z |
      xargs -0 -r -n1 git diff --no-index --src-prefix="a/$name/" --dst-prefix="b/$name/" /dev/null
  } 2>/dev/null | head -c $((${MAX_DIFF_BYTES} + 1))
done
true
`;

async function readWorkspace(sandbox: SandboxSession): Promise<Repository[]> {
  const { stdout } = await sandbox.run({ command: READ_WORKSPACE });
  return stdout
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const newline = record.indexOf("\n");
      const [name = "", remote = "", branch = "", base = "", upstream = ""] = record
        .slice(0, newline)
        .split("\t");
      return {
        base,
        branch,
        diff: record.slice(newline + 1),
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
        ...(repoUrl && repository.pushed && { url: `${repoUrl}/tree/${repository.branch}` }),
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
  let end = diff.length;
  while (Buffer.byteLength(diff.slice(0, end), "utf8") > MAX_DIFF_BYTES) {
    const cut = diff.lastIndexOf("\ndiff --git ", end - 2);
    if (cut < 0) return "";
    end = cut + 1;
  }
  return diff.slice(0, end);
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
