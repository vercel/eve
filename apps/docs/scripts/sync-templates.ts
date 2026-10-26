import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getToken } from "@vercel/connect";

import type { TemplateFile } from "../lib/templates/compose";
import { templateManifest } from "../lib/templates/manifest";
import {
  commitUrl,
  languageForPath,
  rawContentsUrl,
  sortTemplateFiles,
} from "../lib/templates/sync-core";

// Unauthenticated GitHub API calls share a 60/hour limit per IP, which Vercel
// builds exhaust quickly. On Vercel, the build's OIDC token gets a GitHub App
// token through Vercel Connect. GITHUB_TOKEN still wins for local runs.
const GITHUB_CONNECTOR = "github/vercel-templates-public-read";

const resolveToken = async (): Promise<string | undefined> => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (!process.env.VERCEL_OIDC_TOKEN) return undefined;
  try {
    return await getToken(GITHUB_CONNECTOR, { subject: { type: "app" } });
  } catch (error) {
    console.warn(
      `Could not get a GitHub token from Vercel Connect (${GITHUB_CONNECTOR}); ` +
        "falling back to unauthenticated requests.",
      error,
    );
    return undefined;
  }
};

const token = await resolveToken();
const deployedCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (token) headers.Authorization = `Bearer ${token}`;

const githubJson = async <T>(url: string, notFoundMessage: string): Promise<T> => {
  const response = await fetch(url, { headers });
  if (response.status === 404) {
    throw new Error(notFoundMessage);
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub API rate limit or access error (${response.status}) for ${url}` +
        (token
          ? ""
          : `; set GITHUB_TOKEN or link the ${GITHUB_CONNECTOR} connector to this project`),
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
};

const githubText = async (url: string, notFoundMessage: string): Promise<string> => {
  const response = await fetch(url);
  if (response.status === 404) {
    throw new Error(notFoundMessage);
  }
  if (!response.ok) {
    throw new Error(`GitHub raw content request failed (${response.status}) for ${url}`);
  }
  return response.text();
};

console.log(`Syncing templates from GitHub (${token ? "authenticated" : "unauthenticated"})`);

const syncedTemplates = await Promise.all(
  templateManifest.map(async (entry) => {
    const { github } = entry;
    const source =
      deployedCommit && github.owner === "vercel" && github.repo === "eve"
        ? { ...github, ref: deployedCommit }
        : github;
    const commit = await githubJson<{ sha: string }>(
      commitUrl(source),
      `Ref "${source.ref}" not found in ${source.owner}/${source.repo} (template "${entry.slug}")`,
    );

    const [files, readme] = await Promise.all([
      Promise.all(
        entry.files.map(async (relativePath): Promise<TemplateFile> => ({
          contents: await githubText(
            rawContentsUrl(source, commit.sha, relativePath),
            `Curation drift: "${relativePath}" is listed in the manifest for template ` +
              `"${entry.slug}" but does not exist in ` +
              `${github.owner}/${github.repo}@${commit.sha}`,
          ),
          language: languageForPath(relativePath),
          relativePath,
        })),
      ),
      githubText(
        rawContentsUrl(source, commit.sha, "README.md"),
        `README.md not found for template "${entry.slug}" in ` +
          `${github.owner}/${github.repo}@${commit.sha}`,
      ),
    ]);

    return {
      slug: entry.slug,
      data: {
        files: sortTemplateFiles(files),
        readme,
        sourceRevision: commit.sha,
      },
      log: `${entry.slug} ${source.ref} → ${commit.sha.slice(0, 7)} (${files.length} files)`,
    };
  }),
);

const templates = Object.fromEntries(
  syncedTemplates.map(({ data, slug }) => [slug, data]),
) satisfies Record<string, { readme: string; sourceRevision: string; files: TemplateFile[] }>;

for (const template of syncedTemplates) console.log(template.log);

const output = {
  $comment: "Generated during the docs build by scripts/sync-templates.ts. Do not edit.",
  templates,
};

const outputPath = join(import.meta.dirname, "../.template-data/templates.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
