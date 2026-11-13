import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  configuredRoutes,
  configuredSpaces,
  environmentId,
  publicOrigin,
} from "../lib/contentful/config";

/**
 * Describes the configured public URL patterns and their Contentful destinations.
 *
 * @returns Supported URL patterns, or an explicit notice when website lookup is unavailable.
 */
const websiteInstructions = (): string => {
  const origin = publicOrigin();
  const routes = Object.values(configuredRoutes());
  if (!origin || routes.length === 0) {
    return "Public website URL lookup for Contentful entries is unavailable. Only accept direct Contentful entry URLs.";
  }
  const patterns = routes.flatMap(({ contentTypeId, spaceId, urls }) =>
    urls.map(({ prefix }) => {
      const path = [...prefix.split("/").filter(Boolean), "{slug}"].join("/");
      return `- ${origin}/${path}\n  Contentful space: ${spaceId}\n  Content type: ${contentTypeId}`;
    })
  );
  return [
    "Supported public website URLs for Contentful entry lookup:",
    ...patterns,
    "\nRead matching content with get_contentful_entry.",
  ].join("\n");
};

/**
 * Adds Contentful configuration and supported website URL patterns at each turn.
 *
 * @remarks Configuration is resolved when the turn starts so the model can use current deployment values.
 */
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        content: `Configured Contentful spaces (alias: ID): ${JSON.stringify(configuredSpaces())}. Environment: ${environmentId()}. Locale: ${process.env.CONTENTFUL_LOCALE || "each environment's default locale"}. Answer questions about content types and fields from the search_content skill's schema tables. Before creating or editing an entry, read its content type with get_contentful_schema.\n\n${websiteInstructions()}`,
        role: "user",
      }),
  },
});
