import { get, put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ARTIFACT_KINDS,
  artifactId,
  artifactKey,
  MAX_ARTIFACT_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
} from "#lib/artifacts/config.js";

/**
 * The handoff-artifact tools.
 *
 * @remarks
 * A handoff artifact is a Markdown document one agent produces and another reads, passed by id so
 * the text never travels through the lead's context. Every specialist holds both tools; the lead
 * holds only the reader, which is what keeps a relayed document out of the conversation.
 *
 * Key layout, id format, and bounds live in `config.ts`; this module is the tool interface over it.
 *
 * @packageDocumentation
 */

/**
 * Build the tool that saves a handoff artifact.
 *
 * @remarks
 * Long output that another agent needs, but a human does not need to read in a chat thread, goes
 * here instead of into the handback message. The caller returns the id and a short summary, the
 * lead relays the id into the next brief, and the receiving agent reads it. The document itself
 * never passes through the lead's context.
 *
 * The write goes to the team's private Blob store, under a reserved prefix the asset tools refuse.
 * The tool returns an id and never a URL.
 *
 * @returns The `save_artifact` tool definition.
 */
export const saveArtifactTool = () =>
  defineTool({
    description:
      "Save a Markdown document for another agent to read, and get back an id to hand along. Use " +
      "for long output the next specialist needs but nobody wants pasted into a chat thread: an " +
      "SEO audit, research notes, a competitive scan, a content plan. After saving, your reply " +
      "carries the id and a few lines on what's in it, never the document: pasting it back is " +
      "the one thing this tool exists to avoid, and whoever needs the detail opens the id. Not " +
      "for the user's deliverable, which belongs somewhere they can read it, and not for a note " +
      "that fits in a sentence.",
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
        await put(key, markdown, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "text/markdown",
        });
        return { id, kind, saved: true, title };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "Failed to save artifact",
          saved: false,
        };
      }
    },
    inputSchema: z.object({
      kind: z
        .enum(ARTIFACT_KINDS)
        .describe(
          "What this document is. Travels with the id so the reader knows what it's holding."
        ),
      markdown: z
        .string()
        .min(1)
        .max(MAX_ARTIFACT_LENGTH)
        .describe(
          "The full document as Markdown. Write it for the agent that will act on it: findings " +
            "and their evidence, not a narrative."
        ),
      title: z
        .string()
        .min(1)
        .max(MAX_ARTIFACT_TITLE_LENGTH)
        .describe(
          "Human-readable title, e.g. 'Pricing page SEO audit'. The id is derived from it."
        ),
    }),
    outputSchema: z.object({
      error: z.string().optional(),
      id: z
        .string()
        .optional()
        .describe(
          "Hand this to the caller; it is how anyone else reads the document."
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
 * Artifacts are private, so this reads by key through the Blob SDK with the project's credentials
 * and no artifact URL ever reaches the model. An id that fails validation and an id that was never
 * saved both return `found: false`: the ids are model-supplied, and the pattern check is what keeps
 * one from addressing anything outside the reserved prefix.
 *
 * @returns The `read_artifact` tool definition.
 */
export const readArtifactTool = () =>
  defineTool({
    description:
      "Read a Markdown document another agent saved, by the id it handed back. Call this when a " +
      "brief gives you an artifact id: the id is source material to open, never something to " +
      "quote as a citation.",
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
        const result = await get(key, {
          access: "private",
        });
        if (!result?.stream) {
          return { found: false };
        }
        const markdown = await new Response(result.stream).text();
        return {
          createdAt: result.blob.uploadedAt.toISOString(),
          found: true,
          id,
          markdown,
        };
      } catch {
        return { found: false };
      }
    },
    inputSchema: z.object({
      id: z
        .string()
        .min(1)
        .max(200)
        .describe("The artifact id, exactly as it was handed to you."),
    }),
    outputSchema: z.object({
      createdAt: z
        .string()
        .optional()
        .describe(
          "When it was saved. Treat an old artifact as possibly stale."
        ),
      found: z
        .boolean()
        .describe(
          "False when no artifact exists for that id; ask the caller rather than guessing."
        ),
      id: z.string().optional(),
      markdown: z.string().optional(),
    }),
  });
