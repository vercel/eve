import {
  getGitHubPullRequest,
  listGitHubCompareFiles,
  listGitHubPullRequestFiles,
  type GitHubApiOptions,
  type GitHubPullRequestDetails,
  type GitHubPullRequestFile,
} from "#public/channels/github/api.js";
import type { GitHubChannelCredentials } from "#public/channels/github/auth.js";

const MAX_FILES = 50;
const MAX_PATCH_BYTES = 20_000;
const PR_BODY_MAX_LENGTH = 4_000;

/**
 * Built-in glob patterns excluded from the diff loaded into model context.
 *
 * These files are large and generated; their patch text seldom helps the model
 * and consumes context budget. They are still listed with their stats so the
 * agent knows they changed, and the full file is always available from the
 * checkout.
 */
export const GITHUB_DEFAULT_EXCLUDED_DIFF_FILES: readonly string[] = [
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/uv.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
];

/** Controls the pull-request diff injected into GitHub-triggered turns. */
export interface GitHubPullRequestContextConfig {
  /**
   * Additional glob patterns excluded from the diff loaded into model context.
   * Extends the built-in {@link GITHUB_DEFAULT_EXCLUDED_DIFF_FILES} list; it
   * does not replace it. Excluded files are still listed with their stats; only
   * the patch body is omitted.
   */
  readonly excludedFiles?: readonly string[];
}

/** Input for building one-shot model context for a pull request. */
export interface GitHubPullRequestContextInput {
  readonly api?: GitHubApiOptions;
  /**
   * When set with {@link headSha}, file patches load via the compare API for
   * this exact base/head pair instead of `/pulls/{number}/files` (current head).
   */
  readonly baseSha?: string | null;
  readonly config?: GitHubPullRequestContextConfig;
  readonly credentials?: GitHubChannelCredentials;
  /**
   * Webhook-resolved head SHA for this turn. When set, metadata and diffs pin to
   * this commit so injected context matches sandbox checkout.
   */
  readonly headSha?: string | null;
  readonly installationId?: number;
  readonly owner: string;
  readonly pullRequestNumber: number | null;
  readonly repo: string;
}

/**
 * Builds bounded, one-shot pull-request background for a GitHub turn: PR
 * metadata plus the changed-file diff (noisy files excluded from the patch).
 *
 * The returned strings are intended for `SendPayload.context`; each is appended
 * as a `role: "user"` message to session history before the delivery message.
 */
export async function buildGitHubPullRequestContext(
  input: GitHubPullRequestContextInput,
): Promise<readonly string[] | undefined> {
  if (input.pullRequestNumber === null) return undefined;

  const details = withPinnedPullRequestShas(
    await getGitHubPullRequest({
      api: input.api,
      credentials: input.credentials,
      installationId: input.installationId,
      owner: input.owner,
      pullRequestNumber: input.pullRequestNumber,
      repo: input.repo,
    }),
    input,
  );
  const lines = renderPullRequestMetadata(details);

  const pinnedBaseSha = readNonEmptySha(input.baseSha) ?? readNonEmptySha(details.base.sha);
  const pinnedHeadSha = readNonEmptySha(input.headSha) ?? readNonEmptySha(details.head.sha);
  const files =
    readNonEmptySha(input.headSha) !== undefined &&
    pinnedHeadSha !== undefined &&
    pinnedBaseSha !== undefined
      ? (
          await listGitHubCompareFiles({
            api: input.api,
            baseSha: pinnedBaseSha,
            credentials: input.credentials,
            headSha: pinnedHeadSha,
            installationId: input.installationId,
            owner: input.owner,
            repo: input.repo,
          })
        ).slice(0, MAX_FILES)
      : await listGitHubPullRequestFiles({
          api: input.api,
          credentials: input.credentials,
          installationId: input.installationId,
          owner: input.owner,
          perPage: MAX_FILES,
          pullRequestNumber: input.pullRequestNumber,
          repo: input.repo,
        });
  const excluded = [...GITHUB_DEFAULT_EXCLUDED_DIFF_FILES, ...(input.config?.excludedFiles ?? [])];
  lines.push("", ...renderPullRequestFiles(files, excluded));

  return [
    [
      "GitHub pull request context for the current turn. ",
      "Use this as background for the user's GitHub comment.",
      "",
      lines.join("\n"),
    ].join("\n"),
  ];
}

/** Merges channel-generated PR context before hook-provided context. */
export function mergeGitHubContext(input: {
  readonly github?: readonly string[];
  readonly hook?: readonly string[];
}): readonly string[] | undefined {
  const github = input.github ?? [];
  const hook = input.hook ?? [];
  if (github.length === 0 && hook.length === 0) return undefined;
  return [...github, ...hook];
}

function withPinnedPullRequestShas(
  details: GitHubPullRequestDetails,
  input: Pick<GitHubPullRequestContextInput, "baseSha" | "headSha">,
): GitHubPullRequestDetails {
  const headSha = readNonEmptySha(input.headSha);
  const baseSha = readNonEmptySha(input.baseSha);
  if (headSha === undefined && baseSha === undefined) return details;
  return {
    ...details,
    base: { ...details.base, sha: baseSha ?? details.base.sha },
    head: { ...details.head, sha: headSha ?? details.head.sha },
  };
}

function readNonEmptySha(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function renderPullRequestMetadata(details: GitHubPullRequestDetails): string[] {
  return [
    "<github_pull_request>",
    `number: ${details.number}`,
    `title: ${details.title}`,
    `state: ${details.state ?? "unknown"}`,
    `draft: ${details.draft ? "true" : "false"}`,
    ...(details.author?.login ? [`author: ${details.author.login}`] : []),
    ...(details.htmlUrl ? [`url: ${details.htmlUrl}`] : []),
    ...(details.base.ref ? [`base_ref: ${details.base.ref}`] : []),
    ...(details.base.sha ? [`base_sha: ${details.base.sha}`] : []),
    ...(details.head.ref ? [`head_ref: ${details.head.ref}`] : []),
    ...(details.head.sha ? [`head_sha: ${details.head.sha}`] : []),
    ...(details.mergeable === null || details.mergeable === undefined
      ? []
      : [`mergeable: ${details.mergeable ? "true" : "false"}`]),
    ...(details.changedFiles === undefined ? [] : [`changed_files: ${details.changedFiles}`]),
    ...(details.additions === undefined ? [] : [`additions: ${details.additions}`]),
    ...(details.deletions === undefined ? [] : [`deletions: ${details.deletions}`]),
    ...(details.body ? ["", "body:", indent(truncateText(details.body, PR_BODY_MAX_LENGTH))] : []),
    "</github_pull_request>",
  ];
}

function renderPullRequestFiles(
  files: readonly GitHubPullRequestFile[],
  excludedPatterns: readonly string[],
): string[] {
  if (files.length === 0)
    return ["<github_pull_request_files>", "none", "</github_pull_request_files>"];

  const lines = ["<github_pull_request_files>"];
  let remainingPatchBytes = MAX_PATCH_BYTES;
  let truncated = false;

  for (const file of files) {
    lines.push(renderFileSummary(file));

    if (fileMatchesAnyGlob(file.filename, excludedPatterns)) {
      lines.push("  patch omitted (excluded)");
      continue;
    }
    if (file.patch === undefined) continue;

    if (remainingPatchBytes <= 0) {
      truncated = true;
      continue;
    }

    const patch = truncateByBytes(file.patch, remainingPatchBytes);
    lines.push("patch:", indent(patch.text));
    remainingPatchBytes -= patch.bytes;
    if (patch.truncated) {
      truncated = true;
      remainingPatchBytes = 0;
    }
  }

  if (truncated) {
    lines.push("", "patches_truncated: true", `max_patch_bytes: ${MAX_PATCH_BYTES}`);
  }
  lines.push("</github_pull_request_files>");
  return lines;
}

function renderFileSummary(file: GitHubPullRequestFile): string {
  const stats = [
    file.status ?? "modified",
    file.additions === undefined ? undefined : `+${file.additions}`,
    file.deletions === undefined ? undefined : `-${file.deletions}`,
  ].filter((part): part is string => part !== undefined);
  return `- ${file.filename}${stats.length > 0 ? ` (${stats.join(", ")})` : ""}`;
}

/** Returns true when a file path matches any of the provided glob patterns. */
export function fileMatchesAnyGlob(filename: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(filename));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

function truncateByBytes(
  text: string,
  maxBytes: number,
): {
  readonly bytes: number;
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { bytes: bytes.byteLength, text, truncated: false };
  }
  const decoded = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return { bytes: maxBytes, text: `${decoded}\n[truncated]`, truncated: true };
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated]`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
