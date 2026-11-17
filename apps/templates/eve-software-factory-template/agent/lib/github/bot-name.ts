import { getConnectorMetadata } from "@vercel/connect";
import { GITHUB_CONNECTOR } from "./credentials.js";

/**
 * Name used where a resolution failure must not stop the work, like the
 * sandbox commit identity. Matches the template's default persona.
 */
export const FALLBACK_BOT_NAME = "Foreman";

/**
 * Upper bound on a resolved bot name before it is interpolated into a
 * regular expression; GitHub App slugs are far shorter in practice.
 */
const MAX_BOT_NAME_LENGTH = 80;

let resolvedFromConnector: string | undefined;

/**
 * The name the factory answers to in `@mentions`, resolved without setup.
 *
 * @remarks
 * Resolution order:
 * 1. `FACTORY_BOT_NAME`, then `GITHUB_APP_SLUG`, for explicit overrides.
 * 2. The GitHub App's own slug from the Connect connector's metadata
 *    (`vendor.appSlug`), so the mention automatically follows whatever the
 *    deployer named their app. Fetched with the deployment's OIDC token and
 *    cached for the life of the instance.
 *
 * Throws when the metadata is unreachable or carries no usable slug, and the
 * failure is never cached. That contract is what the channel's lazy `botName`
 * resolution relies on: eve calls this on first use inside request handling
 * (where the OIDC token exists), caches a fulfilled name, and retries a
 * rejection on the next event, so a transient outage can't pin a wrong name.
 * Callers that need an answer no matter what catch and use
 * {@link FALLBACK_BOT_NAME}.
 *
 * A hardcoded name is wrong here because the app's slug is chosen by whoever
 * registers it, and a guessed handle can belong to a real GitHub user.
 */
export async function resolveBotName(): Promise<string> {
  const override = process.env.FACTORY_BOT_NAME ?? process.env.GITHUB_APP_SLUG;
  if (override) {
    return override;
  }
  if (resolvedFromConnector !== undefined) {
    return resolvedFromConnector;
  }
  const metadata = await getConnectorMetadata(GITHUB_CONNECTOR);
  const slug = (metadata.vendor as { appSlug?: unknown }).appSlug;
  if (
    typeof slug !== "string" ||
    slug.length === 0 ||
    slug.length > MAX_BOT_NAME_LENGTH
  ) {
    throw new Error(
      `Connector ${GITHUB_CONNECTOR} metadata carries no usable GitHub App slug.`
    );
  }
  resolvedFromConnector = slug;
  return slug;
}

/**
 * Builds the mention matcher for a resolved bot name: `@<name>` on a word
 * boundary, the same shape the channel's built-in comment gate uses.
 *
 * @remarks
 * The name is escaped for literal matching before interpolation, and
 * {@link resolveBotName} bounds its length, so connector-supplied data can
 * never change the pattern's meaning.
 */
export function mentionPattern(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu");
}
