import type { TemplateFile } from "./compose";
import type { TemplateGitHubSource } from "./manifest";

const GITHUB_API = "https://api.github.com";

/** Subset of the GitHub contents API response the sync consumes. */
export interface GitHubContentsResponse {
  content?: string;
  encoding?: string;
  size?: number;
}

export const languageForPath = (path: string): TemplateFile["language"] => {
  if (path.endsWith(".md") || path.endsWith(".mdx")) return "markdown";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  throw new Error(
    `No language mapping for "${path}" — extend TemplateFile["language"] and languageForPath`,
  );
};

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** URL that resolves a branch, tag, or SHA to a commit. */
export const commitUrl = (source: TemplateGitHubSource): string =>
  `${GITHUB_API}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;

/** URL for one template file's contents at a resolved commit SHA. */
export const contentsUrl = (
  source: TemplateGitHubSource,
  sha: string,
  relativePath: string,
): string => {
  const path = source.pathPrefix ? `${source.pathPrefix}/${relativePath}` : relativePath;
  return `${GITHUB_API}/repos/${source.owner}/${source.repo}/contents/${encodePath(path)}?ref=${sha}`;
};

/**
 * Converts a contents API response into a TemplateFile. The API base64-encodes
 * file bodies (with embedded newlines) and omits content above 1 MB.
 */
export const decodeContentsResponse = (
  relativePath: string,
  response: GitHubContentsResponse,
): TemplateFile => {
  if (response.content === "" && (response.size ?? 0) > 1_000_000) {
    throw new Error(
      `"${relativePath}" exceeds the GitHub contents API 1 MB limit (${response.size} bytes) — curate a smaller file`,
    );
  }
  if (response.encoding !== "base64" || typeof response.content !== "string") {
    throw new Error(`Unexpected contents API response for "${relativePath}"`);
  }
  return {
    contents: Buffer.from(response.content, "base64").toString("utf8"),
    language: languageForPath(relativePath),
    relativePath,
  };
};

export const sortTemplateFiles = (files: TemplateFile[]): TemplateFile[] =>
  [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
