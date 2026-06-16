/**
 * Slack mrkdwn ↔ GitHub-flavored markdown converters and the bare
 * `@mention` rewriter used by the outbound post pipeline. These are
 * pure string utilities — no Slack API I/O, no I/O at all — so they
 * live separately from the binding constructor and request shape code
 * in {@link ./api.ts}.
 */

const BARE_MENTION_RE = /(?<![<\w])@(\w+)/gu;

/**
 * Rewrites bare `@USER_ID` tokens (the form Slack apps and humans tend
 * to type) into the `<@USER_ID>` mention syntax Slack actually renders.
 * Anything already wrapped in `<...>` is left untouched.
 */
export function rewriteBareMentions(text: string): string {
  return text.replace(BARE_MENTION_RE, "<@$1>");
}

/**
 * Best-effort GFM → Slack mrkdwn converter used only in contexts that
 * do not support `markdown_text` (e.g. `files.completeUploadExternal`'s
 * `initial_comment` field).
 *
 * The main `{ markdown }` post path sends `markdown_text` directly
 * to `chat.postMessage` and does not go through this converter.
 */
export function gfmToSlackMrkdwn(input: string): string {
  const segments = splitCodeFences(input);
  return segments
    .map((segment) => (segment.kind === "code" ? segment.text : convertInline(segment.text)))
    .join("");
}

/**
 * Best-effort Slack mrkdwn → GFM converter applied to the text of
 * every inbound Slack message before the harness sees it.
 *
 * - `<@U123>`              → `@U123`
 * - `<#C123|name>`         → `#name` (or `#C123` when no name)
 * - `<!channel>` etc.      → `@channel`
 * - `<https://x|label>`    → `[label](https://x)`
 * - `<https://x>`          → `https://x`
 * - `*bold*` (paired)      → `**bold**`
 * - `~strike~` (paired)    → `~~strike~~`
 *
 * Inline `_italic_` and code spans pass through unchanged because both
 * formats render them identically.
 */
export function slackMrkdwnToGfm(input: string): string {
  const segments = splitCodeFences(input);
  return segments
    .map((segment) => (segment.kind === "code" ? segment.text : decodeInline(segment.text)))
    .join("");
}

type Segment = { readonly kind: "text" | "code"; readonly text: string };

function splitCodeFences(input: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRe = /```[\s\S]*?```|`[^`\n]+`/gu;
  let lastIndex = 0;
  for (const match of input.matchAll(fenceRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: "text", text: input.slice(lastIndex, start) });
    }
    segments.push({ kind: "code", text: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < input.length) {
    segments.push({ kind: "text", text: input.slice(lastIndex) });
  }
  return segments;
}

function convertInline(input: string): string {
  let out = input;
  out = out.replace(/\*\*([^*\n]+)\*\*/gu, "*$1*");
  out = out.replace(/__([^_\n]+)__/gu, "*$1*");
  out = out.replace(/~~([^~\n]+)~~/gu, "~$1~");
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, "<$2|$1>");
  return out;
}

function decodeInline(input: string): string {
  let out = input;
  out = out.replace(/<!(channel|here|everyone)>/gu, "@$1");
  out = out.replace(/<@([A-Z0-9]+)\|([^>]+)>/gu, "@$2");
  out = out.replace(/<@([A-Z0-9]+)>/gu, "@$1");
  out = out.replace(/<#([A-Z0-9]+)\|([^>]+)>/gu, "#$2");
  out = out.replace(/<#([A-Z0-9]+)>/gu, "#$1");
  out = out.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/gu, "[$2]($1)");
  out = out.replace(/<(https?:\/\/[^>\s]+)>/gu, "$1");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, "$1**$2**");
  out = out.replace(/(^|[^~])~([^~\n]+)~(?!~)/gu, "$1~~$2~~");
  return out;
}
