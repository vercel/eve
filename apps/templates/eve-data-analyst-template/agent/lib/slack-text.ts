/**
 * Escaping for text that Slack formats as mrkdwn.
 *
 * @packageDocumentation
 */

/**
 * Escapes the three characters Slack mrkdwn reads as control sequences.
 *
 * @param text - Literal text for a mrkdwn field or a message's top-level `text`.
 * @returns The text with `&`, `<`, and `>` as HTML entities, which Slack decodes for display.
 * @remarks Escapes `&` first, so existing entities stay literal. Escaped mentions such as `&lt;!channel&gt;` don't notify anyone.
 */
export const escapeMrkdwn = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Escapes text for the inside of a mrkdwn code block.
 *
 * @param text - Literal text placed between triple-backtick fences.
 * @returns The text escaped by {@link escapeMrkdwn}, with a zero-width space between the backticks of every run of three or more.
 * @remarks mrkdwn has no longer fences, so breaking up each run keeps the text from closing the code block. Copied text keeps the zero-width spaces.
 */
export const escapeMrkdwnCode = (text: string): string =>
  escapeMrkdwn(text).replaceAll(/`{3,}/gu, (run) => [...run].join("​"));
