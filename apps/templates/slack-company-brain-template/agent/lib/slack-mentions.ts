import { defineSlackRenderer } from "eve/channels/slack";

// Code, links, and URLs stay as written, so an ID shown on purpose isn't linked.
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>]+/gu;
// A mention the model wrapped in code formatting, which Slack would show literally.
const CODED_ENTITY = /^`(<[@#][UWCG][A-Z0-9]{7,12}>)`$/u;
const BARE_USER_ID = /(?<![<\w])@([UW][A-Z0-9]{7,12})\b/gu;
const BARE_CHANNEL_ID = /(?<![<\w])#([CG][A-Z0-9]{7,12})\b/gu;

/** Turns `@U…` and `#C…` into Slack's `<@U…>` and `<#C…>` so they render as mentions. */
export function linkSlackEntityIds(text: string): string {
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(PROTECTED_SPAN)) {
    const index = match.index ?? 0;
    result += linkSegment(text.slice(offset, index));
    result += match[0].replace(CODED_ENTITY, "$1");
    offset = index + match[0].length;
  }
  return result + linkSegment(text.slice(offset));
}

function linkSegment(text: string): string {
  return text.replace(BARE_USER_ID, "<@$1>").replace(BARE_CHANNEL_ID, "<#$1>");
}

/** Links mentions in each final reply before eve posts it. */
export const slackMentions = defineSlackRenderer({
  events: {
    "content.completed": (event, _ctx, next) => {
      const { data } = event;
      if (data.kind !== "text" || typeof data.value !== "string") return next();
      return next({ ...event, data: { ...data, value: linkSlackEntityIds(data.value) } });
    },
  },
});
