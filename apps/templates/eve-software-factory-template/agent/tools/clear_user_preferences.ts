import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { deleteDocument } from "#lib/blob.js";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes the current user's saved preferences.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (`ctx.session.auth.current`),
 * never from model input, so a session can only ever clear its own user's preferences.
 * Deletion is irreversible, so it is gated on human approval via `always()`.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete this user's saved preferences. Use only when the user " +
    "explicitly asks to reset or forget their preferences. This is irreversible.",
  /**
   * Delete the current user's preferences file, if any.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns `deleted: true` when a file was removed, `false` when there was nothing to remove,
   * or `success: false` with an `error`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        deleted: false,
        error: "No signed-in user to clear preferences for.",
        success: false,
      };
    }
    try {
      const { existed } = await deleteDocument(key);
      return { deleted: existed, success: true };
    } catch (error) {
      return {
        deleted: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
