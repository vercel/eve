import { slackMrkdwnToMarkdown } from "#compiled/@chat-adapter/slack/format.js";

/** Converts inbound Slack mrkdwn into markdown while preserving code spans and fences. */
export function slackMrkdwnToGfm(input: string): string {
  const segments = splitCodeFences(input);
  return segments
    .map((segment) => (segment.kind === "code" ? segment.text : slackToMarkdown(segment.text)))
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

function slackToMarkdown(input: string): string {
  return slackMrkdwnToMarkdown(input.replace(/<!(channel|here|everyone)>/gu, "@$1"));
}
