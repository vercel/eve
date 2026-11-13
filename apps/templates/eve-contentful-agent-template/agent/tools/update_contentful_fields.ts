import { defineTool } from "eve/tools";

import { requireContentfulEditor } from "../lib/contentful/access";
import { sandboxAssetReader } from "../lib/contentful/assets/sandbox-files";
import { updateContentfulFieldsWithAssets } from "../lib/contentful/assets/update-state";
import { contentfulAssetUpdateInputSchema } from "../lib/contentful/input-schemas";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Saves version-bound Contentful field changes with optional recoverable asset replacement.
 *
 * @remarks Existing entries remain unpublished. Newly declared assets must publish before their links can be saved.
 */
export default defineTool({
  description:
    "Update selected fields on one or more Contentful entries in a configured space. RichText set accepts complete Contentful document JSON with existing reference IDs, except on page bodies. RichText patch edits blocks addressed by the index and hash from read_contentful_content. It works on every writable RichText field, including page bodies; adding, removing, or moving embeds requires the complete ordered embeds list. Read each entry first and discover unfamiliar fields with get_contentful_schema. The tool saves unpublished entry changes, preserves other fields, and rejects stale entry versions. Set assets:null and resumeFrom:null for ordinary edits. To replace images with Slack attachments or public URLs, declare up to five assets with sourcePath or sourceUrl, using the same format as create_contentful_entry. Put { newAsset: key } in each target Asset field or Asset array; reuse one key across fields or entries to upload once. New assets are processed and published before any entry saves; entries are never published. Check complete, each asset stage, and every entry result. On partial results retain recoveryId and Asset IDs; resume with identical inputs to reconcile uncertain saves and reuse uploads. After a version conflict, read and reassess the entry, then use confirmed published Asset IDs in a new assets:null update. Never upload replacement copies or blindly substitute a newer version.",
  /**
   * Executes the tool in the calling session.
   *
   * @param input - Validated entry changes, expected versions, optional assets, and recovery ID.
   * @param ctx - Authenticated tool context carrying cancellation and session identity.
   * @returns Ordered entry-save outcomes and, when applicable, durable asset recovery receipts.
   */
  execute: withLocale(async (input, ctx) => {
    await requireContentfulEditor(ctx);
    return updateContentfulFieldsWithAssets(
      input,
      ctx.session.id,
      ctx.callId,
      ctx.abortSignal,
      sandboxAssetReader(() => ctx.getSandbox())
    );
  }),
  inputSchema: contentfulAssetUpdateInputSchema,
});
