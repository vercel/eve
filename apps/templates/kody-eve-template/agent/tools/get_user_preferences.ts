import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that loads the current user's saved style preferences from Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (`ctx.session.auth.current`),
 * never from model input, so a session can only ever read its own user's preferences. Returns
 * `found: false` with empty `preferences` when the user has none yet — that is a normal state,
 * not an error. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Load this user's saved preferences (standing notes that personalize how you work for " +
    "them). Call it at the start of a task; returns empty when the user has none yet.",
  /**
   * Read the current user's preferences file.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns `found` plus the `preferences` Markdown (empty when none), or an `error`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to load preferences for.",
        found: false,
        preferences: "",
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { found: false, preferences: "" };
      }
      const response = await fetch(blob.url);
      if (!response.ok) {
        return {
          error: `Failed to read preferences: ${response.status} ${response.statusText}`,
          found: false,
          preferences: "",
        };
      }
      return { found: true, preferences: await response.text() };
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
    preferences: z.string(),
  }),
});
