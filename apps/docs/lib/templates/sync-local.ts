import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TemplateFile } from "./compose";
import type { TemplateManifestEntry } from "./manifest";
import { languageForPath, sortTemplateFiles } from "./sync-core";

const within = (directory: string, path: string): string => {
  const absolute = resolve(directory, path);
  const remainder = relative(directory, absolute);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`Local template path escapes its source directory: ${path}`);
  }
  return absolute;
};

/** Local docs previews include uncommitted in-repo templates; external sources still use GitHub. */
export const readLocalTemplate = async (
  entry: Pick<TemplateManifestEntry, "github" | "files">,
  repositoryRoot: string,
  sourceRevision: string,
): Promise<{ files: TemplateFile[]; readme: string; sourceRevision: string } | undefined> => {
  const { github } = entry;
  if (github.owner !== "vercel" || github.repo !== "eve" || !github.pathPrefix) return undefined;
  const directory = within(repositoryRoot, github.pathPrefix);
  const [files, readme] = await Promise.all([
    Promise.all(
      entry.files.map(async (relativePath): Promise<TemplateFile> => ({
        contents: await readFile(within(directory, relativePath), "utf8"),
        language: languageForPath(relativePath),
        relativePath,
      })),
    ),
    readFile(within(directory, "README.md"), "utf8"),
  ]);
  return { files: sortTemplateFiles(files), readme, sourceRevision };
};
