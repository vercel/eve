/**
 * Whether eve answers out loud. Set `MEETING_VOICE=off` to have it answer in
 * the meeting chat only; the bot's camera still shows when it's listening and
 * thinking. Instructions are built at build time, so redeploy after changing it.
 */
export const VOICE_ENABLED = process.env.MEETING_VOICE?.trim().toLowerCase() !== "off";
