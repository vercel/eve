/* Contentful deployment configuration and shared identities. */
import {
  configuredRoutes,
  configuredSpaces,
  environmentId,
  isComponent,
  publicOrigin,
} from "./config";

export const API_HOST = "https://api.contentful.com";
export const UPLOAD_HOST = "https://upload.contentful.com";
export const APP_HOST = "https://app.contentful.com";
export const CONTENTFUL_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * Space identifier used to group entries in the mirror.
 */
export type ListableKind = string;

/**
 * Configured route key or content type ID identifying an approval-requiring page.
 */
export type PageKind = string;

/**
 * Raw Contentful space identifier.
 */
export type ContentfulSpaceId = string;

/**
 * Public URL prefixes associated with one content type in one configured space.
 */
export interface PageRoute {
  contentTypeId: string;
  spaceId: string;
  urls: { prefix: string }[];
}
export const QUERY_SPACES = configuredSpaces();
export const PAGE_ROUTES: Record<string, PageRoute> = configuredRoutes();

/**
 * Builds a CMA base path after enforcing the deployment's space and environment allowlist.
 *
 * @param spaceId - Raw Contentful space ID to access.
 * @param environment - Environment ID; defaults to the deployment configuration.
 * @returns The relative /spaces/.../environments/... API path.
 * @throws {@link Error} When either identifier falls outside the deployment configuration.
 */
export const spacePath = (
  spaceId: string,
  environment = environmentId()
): string => {
  if (!Object.values(configuredSpaces()).includes(spaceId)) {
    throw new Error("Space is not configured in CONTENTFUL_SPACE_IDS.");
  }
  if (!CONTENTFUL_ID.test(environment) || environment !== environmentId()) {
    throw new Error(
      "Environment is not configured in CONTENTFUL_ENVIRONMENT_ID."
    );
  }
  return `/spaces/${spaceId}/environments/${environment}`;
};

/**
 * Classifies an entry for page approval using its space and content type.
 *
 * @param spaceId - Raw Contentful space ID containing the entry.
 * @param contentTypeId - Entry content type used to resolve route and component configuration.
 * @returns A route key or content type ID for pages; null only for explicit component types.
 * @remarks A configured page route takes precedence over a component exemption.
 */
export const pageKindInSpace = (
  spaceId: string,
  contentTypeId: string
): PageKind | null => {
  const route = Object.entries(PAGE_ROUTES).find(
    ([, value]) =>
      value.spaceId === spaceId && value.contentTypeId === contentTypeId
  );
  return (
    route?.[0] ?? (isComponent(spaceId, contentTypeId) ? null : contentTypeId)
  );
};

/**
 * Constructs an optional website URL from the page's first configured route.
 *
 * @param page - Configured route key for the entry's page kind.
 * @param slug - Entry slug encoded as one path segment.
 * @returns A public HTTPS URL, or null when the origin or route is not configured.
 */
export const publicUrl = (page: PageKind, slug: string): string | null => {
  const route = PAGE_ROUTES[page];
  const origin = publicOrigin();
  return origin && route
    ? `${origin}/${[route.urls[0].prefix, encodeURIComponent(slug)].filter(Boolean).join("/")}`
    : null;
};

/**
 * Builds an environment-qualified identity for an entry.
 *
 * @param spaceId - Raw Contentful space ID.
 * @param environment - Contentful environment ID.
 * @param entryId - Entry ID within that environment.
 * @returns A slash-separated key suitable for maps and duplicate detection.
 */
export const entryKey = (
  spaceId: string,
  environment: string,
  entryId: string
): string => `${spaceId}/${environment}/${entryId}`;

export const RICH_TEXT_REFERENCE_NODES = [
  ["embedded-entry-block", "Entry"],
  ["embedded-entry-inline", "Entry"],
  ["entry-hyperlink", "Entry"],
  ["embedded-asset-block", "Asset"],
  ["asset-hyperlink", "Asset"],
] as const;
