import { defineTool } from "eve/tools";
import { z } from "zod";
import { readDocument, writeDocument } from "./blob.js";
import {
  ARTIFACT_KINDS,
  artifactId,
  artifactKey,
  MAX_ARTIFACT_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
} from "./config.js";

/**
 * The handoff-artifact tools.
 *
 * @remarks
 * A handoff artifact is a Markdown document one station produces and another reads, passed by id
 * so the text never travels through the orchestrator's context. Stations that produce long
 * documents hold the saver, stations that consume them hold the reader, and the orchestrator
 * holds only the reader, which is what keeps a relayed document out of the conversation.
 *
 * Key layout, id format, and bounds live in `config.ts`; this module is the tool interface over
 * it. Both tools are inert by construction (validated ids, no overwrite, bounded size), so they
 * are safe inside task-mode stations that cannot park on approval. Authorization resolves from
 * the ambient Vercel OIDC credentials.
 */

/**
 * Build the tool that saves a handoff artifact.
 *
 * @remarks
 * Long output that another station needs, but nobody wants pasted through the orchestrator, goes
 * here instead of into the structured output. The caller returns the id and a short summary, the
 * orchestrator relays the id into the next station's message, and the receiving station reads
 * it. The document itself never passes through the orchestrator's context.
 *
 * @returns The `save_artifact` tool definition.
 */
export const saveArtifactTool = () =>
  defineTool({
    description:
      "Save a Markdown document for another station to read, and get back an id to hand along. " +
      "Use for long supporting detail the next station needs but that does not fit your " +
      "structured output: a full research memo, deep analysis notes with file-level detail and " +
      "code excerpts. After saving, report the id in your structured output with a few lines on " +
      "what's in it, never the document itself: whoever needs the detail opens the id. Not for " +
      "a note that fits in a sentence.",
    /**
     * Write the artifact to Blob under the reserved artifacts prefix.
     *
     * @param input - Validated tool input.
     * @returns The `id` to hand along, or `saved: false` with an `error`.
     */
    async execute({ kind, title, markdown }) {
      const id = artifactId(kind, title);
      const key = artifactKey(id);
      if (!key) {
        return { error: "Could not build a valid artifact id.", saved: false };
      }
      try {
        await writeDocument(key, markdown, { allowOverwrite: false });
        return { id, kind, saved: true, title };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Failed to save artifact",
          saved: false,
        };
      }
    },
    inputSchema: z.object({
      kind: z
        .enum(ARTIFACT_KINDS)
        .describe(
          "What this document is. Travels with the id so the reader knows what it's holding.",
        ),
      markdown: z
        .string()
        .min(1)
        .max(MAX_ARTIFACT_LENGTH)
        .describe(
          "The full document as Markdown. Write it for the station that will act on it: findings and their evidence, not a narrative.",
        ),
      title: z
        .string()
        .min(1)
        .max(MAX_ARTIFACT_TITLE_LENGTH)
        .describe(
          "Human-readable title, e.g. 'Dedupe reset emails analysis'. The id is derived from it.",
        ),
    }),
    outputSchema: z.object({
      error: z.string().optional(),
      id: z
        .string()
        .optional()
        .describe(
          "Report this in your structured output; it is how anyone else reads the document.",
        ),
      kind: z.string().optional(),
      saved: z.boolean(),
      title: z.string().optional(),
    }),
  });

/**
 * Build the tool that reads a handoff artifact back.
 *
 * @remarks
 * Artifacts are read through the authenticated `get` path rather than by fetching a URL. An id
 * that fails validation and an id that was never saved both return `found: false`: the ids are
 * model-supplied, and the pattern check is what keeps one from addressing anything outside the
 * reserved prefix.
 *
 * @returns The `read_artifact` tool definition.
 */
export const readArtifactTool = () =>
  defineTool({
    description:
      "Read a Markdown document another station saved, by the id it handed back. Call this when " +
      "a message gives you an artifact id: the id is source material to open, never something " +
      "to quote as a citation.",
    /**
     * Read the artifact from Blob.
     *
     * @param input - Validated tool input.
     * @returns `found: true` with the document, or `found: false`.
     */
    async execute({ id }) {
      const key = artifactKey(id);
      if (!key) {
        return { found: false };
      }
      try {
        const doc = await readDocument(key);
        if (!doc.found) {
          return { found: false };
        }
        return {
          createdAt: doc.uploadedAt,
          found: true,
          id,
          markdown: doc.content,
        };
      } catch {
        return { found: false };
      }
    },
    inputSchema: z.object({
      id: z.string().min(1).max(200).describe("The artifact id, exactly as it was handed to you."),
    }),
    outputSchema: z.object({
      createdAt: z
        .string()
        .optional()
        .describe("When it was saved. Treat an old artifact as possibly stale."),
      found: z
        .boolean()
        .describe("False when no artifact exists for that id; report that rather than guessing."),
      id: z.string().optional(),
      markdown: z.string().optional(),
    }),
  });
