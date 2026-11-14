import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const spaceMap = z.record(id, id);

/**
 * Reads the configured Contentful allowlist from comma-separated IDs or a JSON alias map.
 *
 * @returns Alias-to-ID mappings plus an identity mapping for every allowed raw space ID.
 * @throws {@link Error} When configuration is malformed or an alias shadows another space ID.
 */
export const configuredSpaces = (): Record<string, string> => {
  const value = process.env.CONTENTFUL_SPACE_IDS?.trim();
  if (!value) {
    return {};
  }
  const spaces = spaceMap.parse(
    value.startsWith("{")
      ? JSON.parse(value)
      : Object.fromEntries(
          value.split(",").map((part) => [part.trim(), part.trim()])
        )
  );
  for (const spaceId of Object.values(spaces)) {
    if (Object.hasOwn(spaces, spaceId) && spaces[spaceId] !== spaceId) {
      throw new Error("Space aliases must not shadow a different space ID.");
    }
    spaces[spaceId] = spaceId;
  }
  return spaces;
};

/**
 * Resolves the single Contentful environment used by this deployment.
 *
 * @returns The validated configured environment ID, defaulting to master.
 * @throws {@link Error} When the configured ID contains unsupported characters.
 */
export const environmentId = (): string =>
  id.parse(process.env.CONTENTFUL_ENVIRONMENT_ID || "master");

const routeSchema = z
  .object({
    contentTypeId: id,
    spaceId: id,
    urls: z
      .array(
        z.object({ prefix: z.string().regex(/^[A-Za-z0-9_/-]*$/u) }).strict()
      )
      .min(1),
  })
  .strict();

/**
 * Validates optional public website routes against the configured space allowlist.
 *
 * @returns Route definitions keyed by the deployment's descriptive page kinds.
 * @throws {@link Error} When route JSON is malformed or a route names an unconfigured space.
 */
export const configuredRoutes = () => {
  const routes = z
    .record(id, routeSchema)
    .parse(JSON.parse(process.env.CONTENTFUL_PAGE_ROUTES || "{}"));
  const spaces = Object.values(configuredSpaces());
  for (const route of Object.values(routes)) {
    if (!spaces.includes(route.spaceId)) {
      throw new Error("Every page route must use a configured space ID.");
    }
  }
  return routes;
};

/**
 * Checks whether a content type may bypass page publication approval.
 *
 * @param spaceId - Raw Contentful space ID, not a friendly alias.
 * @param contentTypeId - Content type whose publication policy is being resolved.
 * @returns True only for types explicitly listed in CONTENTFUL_COMPONENT_TYPES.
 * @throws {@link Error} When the component configuration is malformed.
 */
export const isComponent = (
  spaceId: string,
  contentTypeId: string
): boolean => {
  const components = z
    .record(id, z.array(id))
    .parse(JSON.parse(process.env.CONTENTFUL_COMPONENT_TYPES || "{}"));
  return components[spaceId]?.includes(contentTypeId) ?? false;
};

/**
 * Validates the optional website origin used to construct public entry links.
 *
 * @returns A normalized HTTPS origin, or null when website links are disabled.
 * @throws {@link Error} When the URL includes credentials, a path, query, or fragment.
 */
export const publicOrigin = (): string | null => {
  const value = process.env.CONTENTFUL_PUBLIC_ORIGIN;
  if (!value) {
    return null;
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CONTENTFUL_PUBLIC_ORIGIN must be an HTTPS origin without a path."
    );
  }
  return url.origin;
};

/**
 * Identifies the deployment configuration that prepared a durable operation or mirror.
 *
 * @returns Serialized non-secret space, environment, locale, route, and field-policy settings.
 * @remarks Changing these settings invalidates saved plans before further writes.
 */
export const configurationKey = (): string =>
  JSON.stringify({
    components: process.env.CONTENTFUL_COMPONENT_TYPES || "{}",
    environment: environmentId(),
    locale: process.env.CONTENTFUL_LOCALE || null,
    protectedFields: process.env.CONTENTFUL_PROTECTED_FIELDS || "[]",
    routes: configuredRoutes(),
    spaces: configuredSpaces(),
  });
