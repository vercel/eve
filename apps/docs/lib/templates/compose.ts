import type {
  TemplateCategory,
  TemplateIntegration,
  TemplateManifestEntry,
  TemplateSource,
} from "./manifest";

export interface TemplateFile {
  contents: string;
  language: "markdown" | "typescript";
  relativePath: string;
}

export interface TemplateEntry {
  category: TemplateCategory;
  description: string;
  files: TemplateFile[];
  integrations: TemplateIntegration[];
  model: string;
  readme: string;
  slug: string;
  source: TemplateSource;
  sourceHref: string;
  sourceRevision: string;
  sourceRevisionHref: string;
  setupPrompt: string;
  title: string;
}

/** Shape of the repository snapshot produced before a docs build. */
export interface GeneratedTemplatesInput {
  templates: Record<
    string,
    {
      readme: string;
      sourceRevision: string;
      files: { contents: string; language: string; relativePath: string }[];
    }
  >;
}

const isTemplateFileLanguage = (value: string): value is TemplateFile["language"] =>
  value === "markdown" || value === "typescript";

const SYNC_HINT = "run `pnpm --filter eve-docs templates:sync`";

/**
 * Merges the hand-authored manifest with the generated GitHub data into the
 * entries the templates pages render. Throws when the two are out of sync so
 * a stale or missing sync fails `next build` instead of rendering empty pages.
 */
export const composeTemplateEntries = (
  manifest: TemplateManifestEntry[],
  generated: GeneratedTemplatesInput,
): TemplateEntry[] => {
  const orphanedSlugs = new Set(Object.keys(generated.templates));

  const entries = manifest.map((entry) => {
    const data = generated.templates[entry.slug];
    if (!data) {
      throw new Error(`No generated data for template "${entry.slug}" — ${SYNC_HINT}`);
    }
    orphanedSlugs.delete(entry.slug);

    const generatedPaths = data.files.map((file) => file.relativePath);
    const missing = entry.files.filter((path) => !generatedPaths.includes(path));
    const extra = generatedPaths.filter((path) => !entry.files.includes(path));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Generated files for template "${entry.slug}" do not match its manifest` +
          ` (missing: [${missing.join(", ")}], extra: [${extra.join(", ")}]) — ${SYNC_HINT}`,
      );
    }

    const files = data.files.map((file): TemplateFile => {
      if (!isTemplateFileLanguage(file.language)) {
        throw new Error(
          `Unknown language "${file.language}" for "${file.relativePath}" in template "${entry.slug}"`,
        );
      }
      return { contents: file.contents, language: file.language, relativePath: file.relativePath };
    });

    if (!data.readme.trim()) {
      throw new Error(`Generated README is empty for template "${entry.slug}" — ${SYNC_HINT}`);
    }

    const { github: _github, files: _paths, ...curated } = entry;
    const sourceRevisionHref = [
      `https://github.com/${entry.github.owner}/${entry.github.repo}/tree/${data.sourceRevision}`,
      entry.github.pathPrefix,
    ]
      .filter(Boolean)
      .join("/");
    return {
      ...curated,
      files,
      readme: data.readme,
      sourceRevision: data.sourceRevision,
      sourceRevisionHref,
    };
  });

  if (orphanedSlugs.size > 0) {
    throw new Error(
      `Generated data exists for template(s) with no manifest entry: ${[...orphanedSlugs].join(", ")} — ${SYNC_HINT}`,
    );
  }

  return entries;
};
