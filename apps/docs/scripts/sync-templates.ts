import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TemplateFile } from "../lib/templates/compose";
import { templateManifest } from "../lib/templates/manifest";
import {
  commitUrl,
  languageForPath,
  rawContentsUrl,
  sortTemplateFiles,
} from "../lib/templates/sync-core";

const token = process.env.GITHUB_TOKEN;
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
        (token ? "" : " — set GITHUB_TOKEN to authenticate"),
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
    const commit = await githubJson<{ sha: string }>(
      commitUrl(github),
      `Ref "${github.ref}" not found in ${github.owner}/${github.repo} (template "${entry.slug}")`,
    );

    const [files, readme] = await Promise.all([
      Promise.all(
        entry.files.map(
          async (relativePath): Promise<TemplateFile> => ({
            contents: await githubText(
              rawContentsUrl(github, commit.sha, relativePath),
              `Curation drift: "${relativePath}" is listed in the manifest for template ` +
                `"${entry.slug}" but does not exist in ` +
                `${github.owner}/${github.repo}@${commit.sha}`,
            ),
            language: languageForPath(relativePath),
            relativePath,
          }),
        ),
      ),
      githubText(
        rawContentsUrl(github, commit.sha, "README.md"),
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
      log: `${entry.slug} ${github.ref} → ${commit.sha.slice(0, 7)} (${files.length} files)`,
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
