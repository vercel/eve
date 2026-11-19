/**
 * Shapes of Slack IDs that role resolution, memory scopes, and profile lookups accept.
 *
 * @packageDocumentation
 */

/** A Slack member ID, such as `U0123ABCD`, including Enterprise Grid `W` IDs. */
export const SLACK_USER_ID = /^[UW][A-Z0-9]+$/u;

/** A public (`C`) or private (`G`) Slack channel ID. */
export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]+$/u;
