import { defineTool } from "eve/tools";
import { z } from "zod";
import { readDocument } from "#lib/blob.js";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that loads the current user's saved style preferences from Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (`ctx.session.auth.current`),
 * never from model input, so a session can only ever read its own user's preferences. Returns
 * `found: false` with empty `preferences` when the user has none yet, or with a `note` when the
 * run has no user principal at all (unattended intake runs as a service principal) — both are
 * normal states, not errors, so neither sets `error`. Authorization resolves from the ambient
 * Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Load this user's saved preferences (standing notes that personalize how you work for " +
    "them). Call it at the start of a task; returns empty when the user has none yet, or " +
    "when the run has no signed-in user (unattended runs), which is normal.",
  /**
   * Read the current user's preferences file.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns `found` plus the `preferences` Markdown (empty when none, with a `note` when the
   * run has no user principal), or an `error` on a real read failure.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        found: false,
        note: "This run has no signed-in user, so per-user preferences don't apply. That is the normal state for unattended runs; proceed without them.",
        preferences: "",
      };
    }
    try {
      const doc = await readDocument(key);
      if (!doc.found) {
        return { found: false, preferences: "" };
      }
      return { found: true, preferences: doc.content };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to load preferences",
        found: false,
        preferences: "",
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    error: z.string().optional(),
    found: z.boolean(),
    note: z.string().optional(),
    preferences: z.string(),
  }),
});
