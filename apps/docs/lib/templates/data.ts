import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cache } from "react";
import {
  composeTemplateEntries,
  type GeneratedTemplatesInput,
  type TemplateEntry,
} from "./compose";
import { templateManifest } from "./manifest";

export type { TemplateEntry, TemplateFile } from "./compose";
export type { TemplateCategory, TemplateIntegration, TemplateSource } from "./manifest";

const generatedTemplatesPath = join(process.cwd(), ".template-data/templates.json");

export const getTemplateEntries = cache(async (): Promise<TemplateEntry[]> => {
  let contents: string;
  try {
    contents = await readFile(generatedTemplatesPath, "utf8");
  } catch (error) {
    throw new Error(
      `Template build data is missing at ${generatedTemplatesPath}. ` +
        "Run `pnpm --filter eve-docs templates:sync` before rendering template pages.",
      { cause: error },
    );
  }

  return composeTemplateEntries(templateManifest, JSON.parse(contents) as GeneratedTemplatesInput);
});

export const getTemplateEntry = cache(
  async (slug: string): Promise<TemplateEntry | undefined> =>
    (await getTemplateEntries()).find((entry) => entry.slug === slug),
);
