import { defineTool } from "eve/tools";

import { requireContentfulEditor } from "../lib/contentful/access";
import { createContentfulEntryWithAssets } from "../lib/contentful/assets/creation-state";
import { sandboxAssetReader } from "../lib/contentful/assets/sandbox-files";
import { contentfulCreateInputSchema } from "../lib/contentful/input-schemas";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Creates a schema-validated Contentful entry with optional recoverable image assets.
 *
 * @remarks Page types remain drafts; explicitly configured components may publish. Session and call IDs bind recovery state.
 */
export default defineTool({
  description:
    "Create one Contentful entry in a configured space. Entries other than explicitly configured supporting component types are saved as drafts; supporting entries are immediately published. Page drafts accept available fields or an empty fields array: omit missing required values without asking for them or inventing placeholders. A new page can include its body as complete Contentful document JSON with existing reference IDs; later body edits use update_contentful_fields with operation=patch. Discover unfamiliar fields with get_contentful_schema and check for existing matching entries using available identifiers first; a slug is not required to save a draft. Create child components before parents and use their returned IDs. Existing Entry/Asset links must already be published. assets:null creates no files; otherwise declare up to five assets using exactly one sourceUrl (public HTTPS) or sourcePath (a staged image under /workspace/.eve/attachments) per asset. For Slack attachments, discover the original sandbox path with file tools; do not pass private Slack URLs or base64. File uploads accept PNG, JPEG, GIF, WebP, and AVIF up to 20 MiB. Reference declared assets with { newAsset: key } in Asset fields or arrays. The tool creates, processes, and publishes these assets before the entry. For supporting entries without assets, check publication. All pages and creations with assets return publicationTarget, complete, every asset stage, and entry.stage. A draft target completes at entry.stage=created; a published target completes at entry.stage=published. Only published confirms publication. Return the draft editor link; publish pages only through the separate explicitly requested approval flow. resumeFrom:null starts a new operation. On a partial page or asset-backed result, preserve all IDs and resume with its recoveryId and identical inputs in this session. Uploaded means only the binary upload is confirmed, not asset publication. An uncertain upload without an ID or an expired upload requires inspection in Contentful; never retry the upload or start a replacement operation. Never replace assets after a timeout. Never repeat creation after a partial or uncertain failure; recover the existing entry instead.",
  /**
   * Executes the tool in the calling session.
   *
   * @param input - Creation fields, declared assets, and optional recovery ID validated by contentfulCreateInputSchema.
   * @param ctx - Authenticated tool context carrying cancellation and session identity.
   * @returns Creation outcome with reserved identities, asset progress, and the applicable publication target.
   */
  execute: withLocale(async (input, ctx) => {
    await requireContentfulEditor(ctx);
    return createContentfulEntryWithAssets(
      input,
      ctx.session.id,
      ctx.callId,
      ctx.abortSignal,
      sandboxAssetReader(() => ctx.getSandbox())
    );
  }),
  inputSchema: contentfulCreateInputSchema,
});
