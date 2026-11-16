import type { SessionAuthContext } from "eve/context";

import { analystConfig } from "#lib/analyst/config";
import type { AnalystConfig } from "#lib/analyst/config";
import { SLACK_CHANNEL_ID, SLACK_USER_ID } from "#lib/slack-ids";
import { isString } from "#lib/values";

/** The Postgres role a caller queries as, or why they can't query. */
export type RoleResolution =
  | { readonly ok: true; readonly role: string }
  | { readonly ok: false; readonly reason: string };

const deny = (reason: string): RoleResolution => ({ ok: false, reason });

/**
 * Checks whether a principal is a person who can answer approval prompts.
 *
 * @param auth - Authenticated principal.
 * @returns True for users and for the `local-dev` principal, which only exists under `eve dev` and local `eve eval`.
 */
export const isInteractiveHuman = (auth: SessionAuthContext): boolean =>
  auth.principalType === "user" || auth.principalType === "local-dev";

/* The verified Slack user and channel behind a Slack person, from webhook attributes eve set. */
const slackOrigin = (auth: SessionAuthContext) => {
  if (auth.authenticator !== "slack-webhook" || auth.principalType !== "user") {
    return { channelId: null, userId: null };
  }
  const { channel_id: channelId, user_id: userId } = auth.attributes;
  return {
    channelId:
      isString(channelId) && SLACK_CHANNEL_ID.test(channelId)
        ? channelId
        : null,
    userId: isString(userId) && SLACK_USER_ID.test(userId) ? userId : null,
  };
};

/* True for IDs shaped like bare Slack user or channel IDs, which only verified Slack attributes may supply. */
const isBareSlackId = (id: string) =>
  SLACK_USER_ID.test(id) || SLACK_CHANNEL_ID.test(id);

/* A map entry, or undefined when the key isn't listed. */
const entry = (config: AnalystConfig, key: string | null) =>
  key !== null && Object.hasOwn(config.ANALYST_ROLE_MAP, key)
    ? config.ANALYST_ROLE_MAP[key]
    : undefined;

/**
 * Resolves the Postgres role a caller queries as.
 *
 * @param auth - The current caller, or null when the session is unauthenticated.
 * @param config - Warehouse settings; defaults to the environment.
 * @returns The role whose grants and row-level security decide what this caller can see, or a denial reason.
 * @remarks `ANALYST_ROLE_MAP` keys are full principal IDs, bare Slack user IDs (`U…`/`W…`), or Slack channel IDs (`C…`/`G…`). Bare Slack IDs match only through verified Slack webhook attributes, never as another caller's principal ID. Precedence: an empty entry under either the full principal ID or the bare Slack user ID denies everywhere; then the current channel's role; then the person's own role, where the full principal ID wins when both forms name a role; then `ANALYST_DEFAULT_ROLE` (empty means allowlist mode). Channel roles apply only to Slack people, never to bots, workflows, or service and runtime callers, which are denied unless their principal ID is mapped.
 */
export const resolveAnalystRole = (
  auth: SessionAuthContext | null,
  config: AnalystConfig = analystConfig()
): RoleResolution => {
  if (!auth) {
    return deny("You need to be signed in to query the warehouse.");
  }
  const { channelId, userId } = slackOrigin(auth);
  // Bare Slack IDs only match through the verified Slack origin above.
  const byPrincipal = isBareSlackId(auth.principalId)
    ? undefined
    : entry(config, auth.principalId);
  const byUserId = entry(config, userId);
  if (byPrincipal === "" || byUserId === "") {
    return deny("Your warehouse access has been turned off.");
  }
  const personal = byPrincipal ?? byUserId;
  const channel = entry(config, channelId);
  if (channel !== undefined) {
    return channel
      ? { ok: true, role: channel }
      : deny("Warehouse questions are turned off in this channel.");
  }
  if (personal) {
    return { ok: true, role: personal };
  }
  if (isInteractiveHuman(auth)) {
    return config.ANALYST_DEFAULT_ROLE
      ? { ok: true, role: config.ANALYST_DEFAULT_ROLE }
      : deny(
          "You haven't been given warehouse access. Ask an admin to add you to ANALYST_ROLE_MAP."
        );
  }
  return deny(
    "Bots, workflows, and service callers can't query the warehouse unless ANALYST_ROLE_MAP lists them."
  );
};

/**
 * Resolves the current caller's role or throws the denial reason.
 *
 * @param session - Session whose current caller, from trusted eve authentication, is checked.
 * @returns The caller's Postgres role.
 * @throws {@link Error} With an explanation the model can relay when the caller can't query.
 */
export const requireAnalystRole = (session: {
  readonly auth: { readonly current: SessionAuthContext | null };
}): string => {
  const access = resolveAnalystRole(session.auth.current);
  if (!access.ok) {
    throw new Error(access.reason);
  }
  return access.role;
};
