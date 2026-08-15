import type { TemplateFile } from "./compose";
import type { TemplateGitHubSource } from "./manifest";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

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

/** Immutable raw URL for one template file at a resolved commit SHA. */
export const rawContentsUrl = (
  source: TemplateGitHubSource,
  sha: string,
  relativePath: string,
): string => {
  const path = source.pathPrefix ? `${source.pathPrefix}/${relativePath}` : relativePath;
  return `${GITHUB_RAW}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(sha)}/${encodePath(path)}`;
};

export const sortTemplateFiles = (files: TemplateFile[]): TemplateFile[] =>
  [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
