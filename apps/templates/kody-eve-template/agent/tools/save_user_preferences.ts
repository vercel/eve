import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Maximum size of a user-preferences document, in characters.
 *
 * @remarks
 * Preferences are a short, curated set of standing notes — not a transcript. The bound keeps the
 * file small and cheap to load into context on every draft.
 */
const MAX_PREFERENCES_LENGTH = 20_000;

/**
 * Tool that saves the current user's style preferences to Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (`ctx.session.auth.current`),
 * never from model input, so a session can only ever write its own user's preferences. This
 * overwrites the whole document, so the caller should `get_user_preferences` first, integrate
 * the new standing preference, and save the merged result — keeping the file curated rather than
 * append-only. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Save this user's standing preferences (Markdown). Overwrites the whole document: " +
    "load the current preferences first, merge in the new one, then save. Use only for durable " +
    "preferences the user states, not one-off instructions for a single task.",
  /**
   * Write the current user's preferences file.
   *
   * @param input - Validated tool input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns `success: true` with the stored `pathname`, or `success: false` with an `error`.
   */
  async execute({ preferences }, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to save preferences for.",
        success: false,
      };
    }
    try {
      const blob = await put(key, preferences, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "text/markdown",
      });
      return { pathname: blob.pathname, success: true };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to save preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({
    preferences: z
      .string()
      .min(1)
      .max(MAX_PREFERENCES_LENGTH)
      .describe(
        "The full preferences document as Markdown: the merged result, not just the new note."
      ),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    pathname: z.string().optional(),
    success: z.boolean(),
  }),
});
