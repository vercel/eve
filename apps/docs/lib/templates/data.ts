import {
  composeTemplateEntries,
  type GeneratedTemplatesInput,
  type TemplateEntry,
} from "./compose";
import generatedTemplates from "./generated/templates.json";
import { templateManifest } from "./manifest";

export type { TemplateEntry, TemplateFile } from "./compose";
export type { TemplateCategory, TemplateIntegration, TemplateSource } from "./manifest";

export const templateEntries: TemplateEntry[] = composeTemplateEntries(
  templateManifest,
  generatedTemplates as GeneratedTemplatesInput,
);

export const getTemplateEntry = (slug: string): TemplateEntry | undefined =>
  templateEntries.find((entry) => entry.slug === slug);
