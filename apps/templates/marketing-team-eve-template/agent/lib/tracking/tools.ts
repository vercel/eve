import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  addTrackingParams,
  MAX_TAG_LENGTH,
  MAX_TRACKED_LINKS,
  MAX_TRACKED_URL_LENGTH,
  mediumForSurface,
  normalizeTag,
} from "#lib/tracking/config.js";

/**
 * The campaign-tracking tool.
 *
 * @remarks
 * Analytics groups on exact strings, so a campaign tagged by hand across a week of posts arrives as
 * several campaigns. This is the one interface that tags a link, and it derives source and medium
 * from a fixed surface enum so they can't be spelled two ways.
 *
 * The vocabulary and the URL building live in `config.ts`; this module is the tool interface over
 * it.
 *
 * @packageDocumentation
 */

/**
 * Build the tool that adds campaign parameters to links.
 *
 * @remarks
 * Batched, because a newsletter carries several links that all belong to one campaign and one
 * surface. `utm_source` and `utm_medium` come from the surface rather than from free text, which is
 * the whole reason this is a tool: hand-tagged campaigns fragment in analytics the moment two
 * people spell the source differently.
 *
 * A malformed URL fails that link alone and the rest of the batch still comes back tagged, so one
 * bad entry in a newsletter doesn't cost the other seven.
 *
 * @param surfaces - Content surfaces this agent publishes to.
 * @returns The `build_tracked_link` tool definition.
 */
export const buildTrackedLinkTool = (
  surfaces: readonly [string, ...string[]]
) =>
  defineTool({
    description:
      "Add campaign tracking parameters to one or more links, so a campaign shows up as one " +
      "campaign in analytics instead of several spellings of it. Source and medium come from the " +
      "surface, and the campaign name is normalized, so don't hand-write utm_ parameters. Use it " +
      "for links that leave for your own site from a post, an email, or anywhere you want the " +
      "visit attributed. Don't use it on a link between two pages of your own site: tagging " +
      "those splits sessions and creates duplicate URLs.",
    /**
     * Tag each link with the campaign parameters.
     *
     * @param input - Validated tool input.
     * @returns The tagged `links`, and the `source`, `medium`, and `campaign` applied.
     */
    execute({ surface, campaign, links }) {
      const normalizedCampaign = normalizeTag(campaign);
      if (!normalizedCampaign) {
        return {
          campaign: "",
          error:
            "The campaign name has no letters or digits in it, so there is nothing to tag with.",
          links: [],
          medium: "",
          source: "",
        };
      }
      const medium = mediumForSurface(surface);
      return {
        campaign: normalizedCampaign,
        links: links.map(({ url, content }) => {
          const normalizedContent = content ? normalizeTag(content) : "";
          const params: Record<string, string> = {
            utm_campaign: normalizedCampaign,
            utm_medium: medium,
            utm_source: surface,
          };
          if (normalizedContent) {
            params.utm_content = normalizedContent;
          }
          const tracked = addTrackingParams(url, params);
          return tracked
            ? { original: url, tracked }
            : {
                error:
                  "Not an absolute http or https URL, so it was left alone.",
                original: url,
              };
        }),
        medium,
        source: surface,
      };
    },
    inputSchema: z.object({
      campaign: z
        .string()
        .min(1)
        .max(MAX_TAG_LENGTH)
        .describe(
          "What this campaign is called, the same string across every link and surface in it. " +
            "Normalized to lowercase and hyphens, so 'Q3 Launch' and 'q3-launch' group together."
        ),
      links: z
        .array(
          z.object({
            content: z
              .string()
              .max(MAX_TAG_LENGTH)
              .optional()
              .describe(
                "Which link this is, when one campaign has several: 'header-cta', 'footer', " +
                  "'post-2'. Sets utm_content so they can be told apart."
              ),
            url: z
              .string()
              .min(1)
              .max(MAX_TRACKED_URL_LENGTH)
              .describe(
                "The absolute destination URL. Existing query parameters and the fragment are kept."
              ),
          })
        )
        .min(1)
        .max(MAX_TRACKED_LINKS)
        .describe(
          "Every link in this campaign. Pass them together rather than one call per link."
        ),
      surface: z
        .enum(surfaces)
        .describe(
          "Where the link will appear. Sets utm_source, and utm_medium is derived from it."
        ),
    }),
    outputSchema: z.object({
      campaign: z
        .string()
        .describe("The normalized utm_campaign that was applied."),
      error: z.string().optional(),
      links: z
        .array(
          z.object({
            error: z
              .string()
              .optional()
              .describe(
                "Why this link was left untagged. Absent when it worked."
              ),
            original: z.string(),
            tracked: z
              .string()
              .optional()
              .describe("The tagged URL. Use this one, not the original."),
          })
        )
        .describe("One entry per link, in the order given."),
      medium: z.string().describe("The utm_medium derived from the surface."),
      source: z.string().describe("The utm_source, which is the surface."),
    }),
  });
