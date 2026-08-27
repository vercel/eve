import {
  formatSlackLink,
  markdownBoldToSlackMrkdwn,
  slackMrkdwnToMarkdown,
} from "#compiled/@chat-adapter/slack/format.js";

/** Converts markdown into Slack mrkdwn for legacy Slack text surfaces. */
export function gfmToSlackMrkdwn(input: string): string {
  const segments = splitCodeFences(input);
  return segments
    .map((segment) => (segment.kind === "code" ? segment.text : markdownToSlack(segment.text)))
    .join("");
}

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

function markdownToSlack(input: string): string {
  let output = markdownBoldToSlackMrkdwn(input);
  output = output.replace(/__([^_\n]+)__/gu, "*$1*");
  output = output.replace(/~~([^~\n]+)~~/gu, "~$1~");
  output = output.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/gu,
    (match: string, label: string, url: string) => formatMarkdownLink(match, label, url),
  );
  return output;
}

function slackToMarkdown(input: string): string {
  return slackMrkdwnToMarkdown(input.replace(/<!(channel|here|everyone)>/gu, "@$1"));
}

function formatMarkdownLink(match: string, label: string, url: string): string {
  try {
    return formatSlackLink(url, label);
  } catch (error) {
    if (error instanceof TypeError) {
      return match;
    }
    throw error;
  }
}
