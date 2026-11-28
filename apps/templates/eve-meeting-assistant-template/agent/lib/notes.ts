import { defineState } from "eve/context";

import {
  appendBlocks,
  block,
  createPage,
  parentPageId,
  readChildIds,
  inlineMarkdown,
  updateBlock,
  type NotionBlockInput,
} from "./notion.js";

export type Section = "actions" | "decisions" | "notes";

const SECTION_TITLES: Record<Section, string> = {
  actions: "Action items",
  decisions: "Decisions",
  notes: "Notes",
};

/** The meeting's notes page. eve writes only below its own blocks, so people can edit freely. */
export interface NotesPage {
  readonly pageId: string;
  readonly url: string;
  readonly summaryId: string;
  /** Each section's heading, and the last block eve added under it. */
  readonly sections: Record<Section, { readonly headingId: string; readonly lastId: string }>;
}

export const notesPage = defineState<NotesPage | null>("meetings.notes-page", () => null);

const SUMMARY_PLACEHOLDER = "eve keeps this summary up to date during the meeting.";

export async function ensureNotesPage(title?: string): Promise<NotesPage & { created: boolean }> {
  const existing = notesPage.get();
  if (existing) return { ...existing, created: false };

  const date = new Date().toISOString().slice(0, 10);
  const sections = Object.keys(SECTION_TITLES) as Section[];
  const page = await createPage({
    parentId: parentPageId(),
    title: `${title?.trim() || "Meeting notes"} (${date})`,
    children: [
      block("callout", SUMMARY_PLACEHOLDER, { icon: { type: "emoji", emoji: "📝" } }),
      ...sections.map((section) => block("heading_2", SECTION_TITLES[section])),
    ],
  });
  // Creating a page doesn't return its children, so read their ids back once.
  const [summaryId, ...headingIds] = await readChildIds(page.id);
  if (!summaryId || headingIds.length < sections.length) {
    throw new Error("Notion created the notes page without its sections.");
  }
  const created: NotesPage = {
    pageId: page.id,
    url: page.url,
    summaryId,
    sections: Object.fromEntries(
      sections.map((section, i) => [
        section,
        { headingId: headingIds[i]!, lastId: headingIds[i]! },
      ]),
    ) as NotesPage["sections"],
  };
  notesPage.update(() => created);
  return { ...created, created: true };
}

export async function setSummary(page: NotesPage, summary: string): Promise<void> {
  await updateBlock(page.summaryId, { callout: { rich_text: inlineMarkdown(summary) } });
}

/**
 * Adds blocks under a section: after eve's last block there, else right
 * under the heading, else at the end of the page, when people deleted them.
 */
export async function addToSection(
  page: NotesPage,
  section: Section,
  blocks: readonly NotionBlockInput[],
): Promise<string | undefined> {
  if (blocks.length === 0) return undefined;
  const { headingId, lastId } = page.sections[section];
  let added;
  try {
    added = await appendBlocks(page.pageId, blocks, lastId);
  } catch {
    try {
      added = await appendBlocks(page.pageId, blocks, headingId);
    } catch {
      added = await appendBlocks(page.pageId, blocks);
    }
  }
  const newLast = added.at(-1)?.id ?? lastId;
  notesPage.update((current) =>
    current === null
      ? current
      : {
          ...current,
          sections: { ...current.sections, [section]: { headingId, lastId: newLast } },
        },
  );
  return added[0]?.id;
}
