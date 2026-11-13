import { defineTool } from "eve/tools";

import { slackThreadFromSession } from "#lib/integrations/slack/session";

import { requireContentfulEditor } from "../lib/contentful/access";
import { contentfulPublishInputSchema } from "../lib/contentful/input-schemas";
import { withContentfulLocale } from "../lib/contentful/locale";
import type { ContentfulPublicationOutcome } from "../lib/contentful/publication";
import {
  getOrPrepareContentfulPublication,
  publishPlannedContentfulEntries,
} from "../lib/contentful/publication-state";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Publishes a frozen Contentful dependency plan after the applicable human approval.
 *
 * @remarks Any authenticated user can approve. Batches containing pages require a delivered Slack plan; explicit component-only batches may proceed immediately.
 */
export default defineTool({
  approval: {
    request: async ({ session, toolInput, callId }) => {
      try {
        await requireContentfulEditor({ session });
        const plan = await withContentfulLocale(
          contentfulPublishInputSchema.parse(toolInput).space,
          () => getOrPrepareContentfulPublication(callId, toolInput)
        );
        if (!plan.requiresApproval) {
          return "not-applicable";
        }
        if (!slackThreadFromSession({ session })) {
          throw new Error(
            "A Slack thread is required to display the publication plan for approval."
          );
        }
        return "user-approval";
      } catch (error) {
        return {
          reason:
            error instanceof Error
              ? error.message
              : "Unable to prepare entries for publishing.",
          type: "denied" as const,
        };
      }
    },
    response: ({ response }) =>
      response.principal.principalType === "user"
        ? { status: "allowed" }
        : {
            reason: "An authenticated user must approve or cancel publication.",
            status: "rejected",
          },
  },
  description:
    "Publish 1–20 existing Contentful entries in a configured space, including pages and supporting components, at their requested versions. Read each entry first and provide its entry ID and expected version. " +
    "Publishing makes all pending changes live. " +
    "If nothing needs publishing, returns nothingToPublish=true after verification. Publishing a batch containing a page requires approval of the complete publication scope. " +
    "Page publication includes draft and changed supporting entries and processed assets, including nested references, in the saved approval plan. Publishes dependencies first; changed shared references can affect other pages. Unchanged references are not republished. Linked pages must be explicitly requested to publish their edits. Component-only batches include draft dependencies but retain pending edits on live references unless explicitly requested. " +
    "Rejects stale versions, missing or archived references, cycles, and unprocessed assets before any writes. Plans allow up to 100 publications, 500 total targets, and 20 dependency levels. " +
    "Publishes sequentially and stops on the first failure. Check complete and each result: published, alreadyPublished, failed, or notAttempted. No automatic retries or rollback.",
  /**
   * Executes the tool in the calling session.
   *
   * @param input - Validated publication roots and the exact versions the caller read.
   * @param ctx - Authenticated tool context carrying cancellation and session identity.
   * @returns Ordered publication outcomes, including resources left untouched after a failure.
   */
  execute: withLocale(async (input, ctx) => {
    await requireContentfulEditor(ctx);
    return publishPlannedContentfulEntries(ctx.callId, input, ctx.abortSignal);
  }),
  inputSchema: contentfulPublishInputSchema,
  toModelOutput(output: ContentfulPublicationOutcome) {
    return {
      type: "json",
      value: {
        complete: output.complete,
        nothingToPublish: output.nothingToPublish,
        results: output.results.map((item) => ({
          contentfulUrl: item.contentfulUrl,
          id: item.id,
          kind: item.kind,
          outcome: item.outcome,
          role: item.role,
          title: item.title,
          version: item.version,
          ...(item.url && { url: item.url }),
          ...(item.error && { error: item.error }),
        })),
      },
    };
  },
});
