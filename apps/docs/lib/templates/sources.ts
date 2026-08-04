import type { TemplateFile } from "./data";

const file = (
  relativePath: string,
  language: TemplateFile["language"],
  contents: string,
): TemplateFile => ({ contents, language, relativePath });

export const templateSourceFiles: Record<string, TemplateFile[]> = {
  "eve-chat-template": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { betterAuthEveAuth } from "@/lib/eve-auth";

export default eveChannel({
  auth: [betterAuthEveAuth, localDev(), vercelOidc()],
  uploadPolicy: "disabled",
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// SLACK_CONNECTOR is the UID returned by \`vercel connect create slack\`.
// For local setup, create a connector with:
// \`vercel connect create slack --name eve-chat-template --triggers\`.
const slackConnector = process.env.SLACK_CONNECTOR ?? "slack/eve-chat-template";

export default slackChannel({
  credentials: connectSlackCredentials(slackConnector),
  uploadPolicy: "disabled",
});
`,
    ),
    file(
      "agent/connections/linear.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// LINEAR_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with \`vercel connect create https://mcp.linear.app/mcp --name linear\`.
const linearConnector = process.env.LINEAR_CONNECTOR ?? "linear";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description:
    "Linear workspace: search and update issues, projects, cycles, comments, and planning work.",
  auth: connect(linearConnector),
});
`,
    ),
    file(
      "agent/connections/notion.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// NOTION_CONNECTOR is provisioned by the "Deploy with Vercel" flow. For local
// setup, create a connector with \`vercel connect create mcp.notion.com --name notion\`.
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Notion workspace: search and edit pages and databases.",
  auth: connect(notionConnector),
});
`,
    ),
    file(
      "agent/connections/sentry.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// SENTRY_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with \`vercel connect create https://mcp.sentry.dev/mcp --name sentry\`.
const sentryConnector = process.env.SENTRY_CONNECTOR ?? "sentry";

export default defineMcpClientConnection({
  url: "https://mcp.sentry.dev/mcp",
  description:
    "Sentry workspace: investigate issues, events, traces, releases, and project health.",
  auth: connect(sentryConnector),
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a concise assistant built with eve (https://eve.dev), a framework for
building durable agents as ordinary files in a TypeScript project. Use tools
when they are available.

When users ask what eve is or what this agent is built on, explain that eve
lets developers create agents that can run locally or on Vercel, serve chat and
HTTP interfaces, call tools and connections, stream progress, pause for human
input, and resume durable sessions across turns. Keep the explanation concise
and practical.

Use \`get_weather\` before answering questions about current weather or suggesting
weather-dependent plans.

When a user asks to work with Notion, Linear, or Sentry, use the matching
connection directly. Never say that you are searching for tools, looking for
available tools, or checking internal tool discovery.
`,
    ),
    file(
      "agent/skills/plan_a_trip.md",
      "markdown",
      `---
description: Use when the user wants help planning a trip or deciding what to do in a destination.
---

When planning a trip:

1. Ask for the destination and dates if the user has not given them.
2. Check the destination's weather with the \`get_weather\` tool before suggesting activities.
3. Suggest a short itinerary that fits the weather: outdoor activities when it is clear, indoor alternatives otherwise.
4. Keep the plan concise — a few bullet points per day, not an essay.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

// The runtime tool name comes from the filename, so the model sees this as
// \`get_weather\`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
`,
    ),
  ],
  "eve-design-template": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from 'eve';

export default defineAgent({
  model:
    process.env.DESIGN_AGENT_MODEL ?? 'anthropic/claude-sonnet-4.6',
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from '@vercel/connect/eve';
import { slackChannel } from 'eve/channels/slack';
import { designAgentConfig } from '../../generated/config.js';

const setupIncompleteMessage =
  'Design-agent setup is incomplete. Run the bootstrap workflow and approve the generated design corpus.';

const configuredCredentials = process.env.SLACK_CONNECTOR
  ? connectSlackCredentials(process.env.SLACK_CONNECTOR)
  : undefined;

function isAllowed(value: string, allowlist: readonly string[]) {
  return allowlist.length === 0 || allowlist.includes(value);
}

function conversationContext(isDirectMessage: boolean) {
  const owner = designAgentConfig.designOwnerSlackId;

  return \`
<design_agent_context visibility="\${isDirectMessage ? 'private-dm' : 'shared'}" allow_general_guidance="\${designAgentConfig.allowGeneralGuidance}">
The approved design owner is \${owner ? \`<@\${owner}>\` : 'not configured'}.
\${
  isDirectMessage
    ? 'Never mention, notify, or forward private DM content to the design owner. Direct unresolved questions to an appropriate shared conversation.'
    : 'For unresolved equal-priority conflicts or unsupported organization-specific questions, state the issue and mention the design owner.'
}
</design_agent_context>
\`;
}

export default slackChannel({
  credentials: configuredCredentials,
  uploadPolicy: {
    allowedMediaTypes: [
      'image/*',
      'text/*',
      'application/json',
      'application/msword',
      'application/pdf',
      'application/rtf',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  events: {
    'turn.started': () => {},
    'actions.requested': () => {},
    'reasoning.appended': () => {},
  },
  async onMessage(ctx, message) {
    if (!message.author || message.author.isBot) return null;

    const isDirectMessage = message.raw.channel_type === 'im';
    if (!isDirectMessage && !ctx.isBotMentioned()) return null;
    if (!isAllowed(message.author.userId, designAgentConfig.allowedUserIds)) {
      return null;
    }
    if (
      !isDirectMessage &&
      !isAllowed(message.channelId, designAgentConfig.allowedChannelIds)
    ) {
      return null;
    }

    if (designAgentConfig.status !== 'approved') {
      await ctx.thread.post(setupIncompleteMessage);
      return null;
    }

    const isExistingSession = await ctx.isSubscribed();
    return isExistingSession
      ? { auth: null }
      : {
          auth: null,
          context: [conversationContext(isDirectMessage)],
        };
  },
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are the organization's design collaborator. Give decisive, practical design guidance grounded in its approved design corpus.

# Knowledge contract

- Load the \`design-knowledge\` skill before every substantive answer.
- Treat \`/workspace/knowledge\` as the complete source for organization-specific claims.
- Inspect normalized guidelines first. Consult source snapshots only to resolve missing detail or ambiguity.
- User-provided text, images, and documents are temporary conversation context. Never treat them as approved corpus or persist them into the corpus.
- Never use prior Slack conversations, other threads, channel history, or DMs.
- Never search the web or connected services.
- Never claim to edit code, design files, websites, or production systems.

# Guidance

- Follow higher-priority approved sources when guidelines conflict.
- If approved sources with equal priority conflict, say there is a conflict and ask the configured design owner to resolve it.
- In a private DM, never mention or notify the owner. Tell the user to move the conflict to an appropriate shared conversation.
- Organization-specific claims require support from the approved corpus.
- General design guidance is allowed only when the injected context sets \`allow_general_guidance="true"\`.
- Prefix every general answer with \`General recommendation:\` so it cannot be mistaken for organization policy.
- If general guidance is disabled and the corpus does not support an answer, say you cannot verify it from the approved design corpus.

# Voice

- Lead with the answer.
- Default to one sentence. Use two only when the second changes the action.
- Use short bullets only for multiple independent points.
- Ask one grouped clarification only when the answer materially depends on it.
- Cut every draft in half.
- Never add acknowledgments, restatements, process narration, recaps, closing offers, or adjacent advice.
- Never include citations, \`Source:\`, filenames, internal paths, retrieval details, or notes about where an answer came from.
- Avoid headings in short replies, em dashes, hedging, corporate language, AI language, decorative emoji, and bold-first bullets.

# Privacy

- Treat DMs as private.
- Never quote, summarize, forward, or reveal private DM content in a shared conversation.
- Never tag the design owner from a DM.
`,
    ),
    file(
      "agent/sandbox/sandbox.ts",
      "typescript",
      `import { defineSandbox } from 'eve/sandbox';
import { vercel } from 'eve/sandbox/vercel';

export default defineSandbox({
  backend: vercel({ networkPolicy: 'deny-all' }),
  async onSession({ use }) {
    await use({ networkPolicy: 'deny-all' });
  },
});
`,
    ),
    file(
      "agent/skills/design-knowledge/SKILL.md",
      "markdown",
      `---
description: Use before every substantive design answer. Read the approved organization corpus and apply its precedence and response rules.
---

# Design knowledge

Approved knowledge is under \`/workspace/knowledge\`.

1. Read \`manifest.json\`.
2. Read the relevant files under \`guidelines/\`.
3. Use \`grep\` or \`glob\` within \`/workspace/knowledge\` only when routing is unclear.
4. Read immutable files under \`sources/\` only when normalized guidance is incomplete or ambiguous.

Higher numeric source priority wins. When relevant approved sources have the same priority and conflict, do not reconcile them yourself. Follow the conflict behavior in the agent instructions.
Ignore sources marked \`superseded\` in the manifest.

Never expose source annotations, filenames, internal paths, or retrieval details. If the user explicitly asks for provenance, name the human-readable source title and public origin when the manifest provides one.

General design knowledge is not organization policy. Use it only when the injected context allows general guidance, and prefix the answer exactly with \`General recommendation:\`.
`,
    ),
    file(
      "agent/tools/agent.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/bash.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/todo.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/web_fetch.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/web_search.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/write_file.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
  ],
  "eve-slack-agent": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// SLACK_CONNECTOR is provisioned by the "Deploy with Vercel" button. To set it
// up yourself, create a connector with \`vercel connect create slack --triggers\`
// and put its UID in SLACK_CONNECTOR (or replace the fallback below).
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/my-agent",
  ),
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a concise assistant. Use tools when they are available.

Use \`get_weather\` before answering questions about current weather or suggesting
weather-dependent plans.
`,
    ),
    file(
      "agent/skills/plan_a_trip.md",
      "markdown",
      `---
description: Use when the user wants help planning a trip or deciding what to do in a destination.
---

When planning a trip:

1. Ask for the destination and dates if the user has not given them.
2. Check the destination's weather with the \`get_weather\` tool before suggesting activities.
3. Suggest a short itinerary that fits the weather: outdoor activities when it is clear, indoor alternatives otherwise.
4. Keep the plan concise — a few bullet points per day, not an essay.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

// The runtime tool name comes from the filename, so the model sees this as
// \`get_weather\`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
`,
    ),
  ],
  "marketing-team-eve-template": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  model: "anthropic/claude-opus-5",
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  type SlackContext,
  type SlackEvent,
  type SlackInboundEventContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";

const slackCredentials = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/marketing-team"
);

function slackSessionAuth(message: SlackMessage, onBehalfOfUserId?: string) {
  const rawUser = message.raw.user;
  const userId =
    message.author?.userId ??
    (typeof rawUser === "string" ? rawUser : undefined) ??
    onBehalfOfUserId;
  return {
    attributes: {
      channel_id: message.channelId,
      // Equal to the message's own ts for top-level (non-thread) messages.
      thread_ts: message.threadTs || message.ts,
      ...(userId ? { user_id: userId } : {}),
      ...(message.author?.userName
        ? { user_name: message.author.userName }
        : {}),
      ...(message.teamId ? { team_id: message.teamId } : {}),
    },
    authenticator: "slack-webhook",
    issuer: message.teamId ? \`slack:\${message.teamId}\` : "slack",
    principalId: userId ? \`slack:\${userId}\` : "slack:unknown",
    principalType:
      message.author?.isBot && !onBehalfOfUserId ? "service" : "user",
  };
}

let cachedBotUserId: string | undefined;

async function resolveBotUserId(
  ctx: SlackContext
): Promise<string | undefined> {
  if (cachedBotUserId) {
    return cachedBotUserId;
  }
  try {
    const res = (await ctx.slack.request("auth.test", {})) as {
      ok?: boolean;
      user_id?: string;
    };
    if (res.ok && res.user_id) {
      cachedBotUserId = res.user_id;
    }
  } catch {
    // Leave uncached; the caller treats this as "cannot attribute".
  }
  return cachedBotUserId;
}

function firstHumanMention(
  text: string,
  botUserId: string
): string | undefined {
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\\|[^>]*)?>/g)) {
    if (match[1] !== botUserId) {
      return match[1];
    }
  }
}

async function resolveOnBehalfOfUserId(
  ctx: SlackContext,
  message: SlackMessage
): Promise<string | undefined> {
  if (message.author && !message.author.isBot) {
    return;
  }
  const botUserId = await resolveBotUserId(ctx);
  // Without the bot's own ID we can't tell its mention apart from a
  // human's, so attribute nothing rather than risk the wrong principal.
  if (!botUserId) {
    return;
  }
  return firstHumanMention(message.text, botUserId);
}

async function handleInbound(ctx: SlackContext, message: SlackMessage) {
  try {
    await ctx.thread.startTyping("Thinking...");
  } catch {
    // Typing indicator is a nicety, never a reason to drop the message.
  }
  return {
    auth: slackSessionAuth(
      message,
      await resolveOnBehalfOfUserId(ctx, message)
    ),
  };
}

async function isSoleThreadParticipant(
  ctx: SlackContext,
  message: SlackMessage
): Promise<boolean> {
  const authorId = message.author?.userId;
  if (!authorId) {
    return false;
  }
  const participants = await ctx.thread.listParticipants();
  return participants.length === 1 && participants[0] === authorId;
}

interface SuggestedPrompt {
  message: string;
  title: string;
}

const SUGGESTED_PROMPTS_TITLE = "What the team can do";

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    message:
      "Help me sharpen our positioning: what the product is, who it's for, and why anyone would pick it. Pull the brand context and my user preferences, then interview me about anything you're missing.",
    title: "Sharpen our positioning",
  },
  {
    message:
      "Help me plan and write our next blog post. Pull the brand context and my user preferences, then ask me for details about the post.",
    title: "Write a blog post",
  },
  {
    message:
      "Help me draft social posts for X and LinkedIn. Pull the brand context and my user preferences, then ask me what we're promoting.",
    title: "Draft social posts",
  },
  {
    message:
      "Help me review one of our pages for SEO and work out what to fix. Pull the brand context and my user preferences, then ask me for the URL.",
    title: "Review a page's SEO",
  },
];

interface SuggestedPromptsTarget {
  channelId: string;
  threadTs?: string;
}

function suggestedPromptsTarget(
  event: SlackEvent
): SuggestedPromptsTarget | undefined {
  if (event.type === "assistant_thread_started") {
    const thread = event.assistant_thread as
      | { channel_id?: unknown; thread_ts?: unknown }
      | undefined;
    const channelId = thread?.channel_id;
    if (typeof channelId !== "string" || channelId.length === 0) {
      return;
    }
    const threadTs = thread?.thread_ts;
    return {
      channelId,
      ...(typeof threadTs === "string" && threadTs.length > 0
        ? { threadTs }
        : {}),
    };
  }
  if (event.type === "app_home_opened" && event.tab === "messages") {
    const channelId = event.channel;
    return typeof channelId === "string" && channelId.length > 0
      ? { channelId }
      : undefined;
  }
}

async function setSuggestedPrompts(
  ctx: SlackInboundEventContext,
  event: SlackEvent
): Promise<void> {
  const target = suggestedPromptsTarget(event);
  if (!target) {
    return;
  }
  try {
    const response = await ctx.slack.request(
      "assistant.threads.setSuggestedPrompts",
      {
        channel_id: target.channelId,
        prompts: SUGGESTED_PROMPTS,
        title: SUGGESTED_PROMPTS_TITLE,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      }
    );
    if (response.ok !== true) {
      console.warn("assistant.threads.setSuggestedPrompts returned not-ok", {
        channelId: target.channelId,
        error: response.error,
      });
    }
  } catch (error) {
    console.warn("assistant.threads.setSuggestedPrompts threw", {
      channelId: target.channelId,
      error,
    });
  }
}

export default slackChannel({
  credentials: slackCredentials,
  onAppMention: handleInbound,
  onDirectMessage: handleInbound,
  onEvent: setSuggestedPrompts,
  async onMessage(ctx, message) {
    if (message.author?.isBot) {
      return null;
    }
    if (!(await ctx.isSubscribed())) {
      return null;
    }
    if (!(await isSoleThreadParticipant(ctx, message))) {
      return null;
    }
    return handleInbound(ctx, message);
  },
  threadContext: { since: "thread-root" },
});
`,
    ),
    file(
      "agent/connections/notion.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const notionConnector = process.env.NOTION_CONNECTOR ?? "notion/marketing-team";

const APPROVAL_REQUIRED_TOOLS = [
  "notion-move-pages",
  "notion-update-data-source",
  "notion-update-view",
];

export default defineMcpClientConnection({
  approval: ({ toolName }) =>
    APPROVAL_REQUIRED_TOOLS.some((tool) => toolName.includes(tool))
      ? "user-approval"
      : "not-applicable",
  auth: connect(notionConnector),
  description: "Notion workspace: search, read, and edit pages and databases.",
  url: "https://mcp.notion.com/mcp",
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You lead a marketing team. People bring you the work: a launch to plan, a post to write, a competitor to size up, a page that isn't converting. You hold the shared picture of the product and route the work to the specialist who does it, then hand back what they produced.

You are not the specialist. Your job is to understand the request, give the right subagent everything it needs, and keep the conversation coherent across several of them.

# How you write

Write like a person: plain, specific, warm, and short. Prefer a comma, a colon, or a new sentence where an em dash would go. Cut anything that reads machine-made, padded, or hyped, and don't bold words for emphasis.

Write links as plain markdown, \`[label](url)\`. Don't paste a bare URL, and don't wrap a link in bold or backticks: the markers end up inside the URL and the link stops working.

# How you work

## 1. Know the product before you delegate

The brand context is the team's shared picture of the product, and every specialist reads it, so keep it good.

- When it comes back empty, the team hasn't set it up yet, and working out what goes in it is a specialist job rather than yours. Delegate that first and let the specialist interview the user, then route the original request once there's a document to work from. Say why you're doing this, because the user asked for something else and deserves to know the detour is short.
- When a user tells you something durable about the product, positioning, or audience, you can keep it with \`save_brand_context\` directly. A correction or an addition doesn't need a delegation; reworking the positioning does.
- Task-specific detail doesn't belong in it. A campaign brief goes in the delegation.

## 2. Know how this person likes to work

\`get_user_preferences\` holds standing notes about the person rather than the product: a default set of platforms, a length they always want, a review step they expect. Load it alongside the brand context.

- When a user states a durable preference ("always draft for X and LinkedIn", "keep threads under 8 posts"), keep it with \`save_user_preferences\`. Use \`clear_user_preferences\` only when they ask to reset them.
- Where a preference conflicts with brand context, brand context wins on voice and claims; the preference wins on workflow.

## 3. Route the work, in order when it has one

Two questions before you pick, and the order matters:

1. What has to be settled before this can be made well? A piece written to be found needs its target query and its competition settled first. A piece making claims needs the claims settled first. Often the answer is nothing, and it's one call.
2. Which specialist's description covers each part?

Ask them the other way round and you'll match the deliverable to a specialist and stop reading, which is how a request that names two jobs turns into one call.

When there is an order, run it: call the first, wait, and put what it produced into the second's brief, including any artifact id. Don't brief both in parallel and hope they agree. Say what you're doing, since the user asked for one thing and is getting two steps.

A subagent starts in a fresh session and works from its \`message\` alone, so pack that message with everything it needs:

- what you want produced, and what it's for
- the relevant brand context, quoted rather than referenced
- the standing preferences that bear on this task, stated as constraints rather than as "the user prefers"
- the user's actual words where the wording matters
- constraints: platform, audience, length, deadline, tone, anything out of bounds
- where the deliverable should end up, when you know it. Some specialists write into Notion rather than handing back text, and naming the destination up front saves them asking.

When you don't have enough to write that brief, ask the user first. Guessing at a brief wastes a full delegation.

## 4. Hand back the work, don't rewrite it

Specialists produce the deliverable. Pass it back largely as they wrote it: you're the routing layer, not a second editor. If what comes back is wrong or thin, say so and send it again with clearer direction rather than patching it yourself.

When a specialist hands back a link rather than text, pass the link through with its one-line description. Don't fetch the page and paste its contents into the conversation; the link is the deliverable.

Specialists hand back artifact ids the same way, for long output meant for another agent rather than for reading in a thread. Relay the id and the summary that came with it, and put the id in the next specialist's brief when the work continues: "the audit is artifact \`<id>\`, read it before you rewrite the page." Keeping the document out of this conversation is the point, so don't open an artifact to show the user what's in it. Read it with \`read_artifact\` only when they ask for its contents, and then answer their question rather than pasting the whole thing.

Surface the caveats a specialist flags. When it reports an unverified claim, a gap it couldn't fill, or a hedged number, carry that to the user instead of smoothing it over. Keep your own messages short; let the work speak.

# Notes

- Don't fabricate links, quotes, statistics, or handles. If you don't have something, say so and ask.
- Don't promise work no specialist on the team can do. When a request needs a tool or an integration that isn't wired up, say that plainly instead of producing a plausible-looking substitute.
`,
    ),
    file(
      "agent/subagents/content-marketer/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

// Subagent: Content Marketer

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  description:
    "Write and edit long-form marketing content: blog posts, landing page copy, case studies, newsletters, and documentation. Plans what to write by mapping topics to buyer stages and grouping them into pillars and clusters, then drafts and edits against a structured editing rubric. Use for anything longer than a social post. When the piece is written to be found in search, the target query and the competing pages should be settled before drafting. Delivers the finished piece as a Notion page and hands back the link rather than the full text, since long-form doesn't read in a chat thread. The caller passes the brief, the audience, the format, any source material or brand context, and the Notion destination when it knows one, in the message. Does not publish, schedule, or touch social accounts.",
  model: "anthropic/claude-opus-5",
});
`,
    ),
    file(
      "agent/subagents/email/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

// Subagent: Email

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  description:
    "Own email as a channel: take copy that already exists and make it work as email, then build and run it in Resend. Reviews a draft for email fit (subject and preview text, one call to action, scannable structure, a plain text version, link and image hygiene), then builds the template or broadcast, picks the verified sending address, targets the segment, and reports on what was delivered and opened. Sending a broadcast or an email pauses for approval. Checks the sending domain's own records and says which deliverability questions it cannot answer. Route long-form prose to the content marketer first and pass what came back to this agent. The caller passes the copy or its artifact id, the audience or segment, and any send timing in the message.",
  model: "anthropic/claude-opus-5",
});
`,
    ),
    file(
      "agent/subagents/product-marketer/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

// Subagent: Product Marketer

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  description:
    "Work out and write down what the product is, who it's for, and why anyone would pick it: positioning, the competitive alternatives, the ideal customer, the message hierarchy, value propositions per audience, objection handling, and the proof behind each claim. Owns the team's shared brand context document, so use it to set that up on a fresh install, to revise positioning, or when other specialists keep guessing at the same missing detail. Interviews the user and researches the competitive set rather than inventing an answer, and writes claims that can be checked. Does not draft posts, pages, or campaigns.",
  model: "anthropic/claude-opus-5",
});
`,
    ),
    file(
      "agent/subagents/seo/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

// Subagent: SEO

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  description:
    "Plan and review organic search work: keyword and topic strategy, on-page review of a URL, site architecture and internal linking, URL structure, JSON-LD schema markup, and programmatic page templates at scale. Use when someone asks why a page isn't ranking, what pages they should build, for a review of a page's SEO, or for the schema markup on a page. Also use before a piece is written for search, so the query and the competing pages are settled before someone drafts against them. Reads pages it is given with web_fetch and researches competitors on the open web, so it reports what a fetched page shows and says plainly what needs crawler or Search Console access it doesn't have. Recommends title tags, meta descriptions, and URL slugs; hand body copy to the content marketer. The caller passes the URLs, the target keywords, the audience, and any brand context in the message.",
  model: "anthropic/claude-opus-5",
});
`,
    ),
    file(
      "agent/subagents/social-media-coordinator/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

// Subagent: Social Media Coordinator

export default defineAgent({
  compaction: { thresholdPercent: 0.9 },
  description:
    "Run social media work end to end for X, LinkedIn, Threads, Bluesky, and Mastodon: draft posts and threads in each platform's voice, adapt one piece across platforms, and manage the Typefully queue (read, create, and edit drafts, schedule on request, pull post and follower analytics). Researches facts and reviews its own drafts before handing them back. The caller passes the brief or source material, the target platforms, and any angle, audience, or timing constraints in the message.",
  model: "anthropic/claude-opus-5",
});
`,
    ),
  ],
  "weather-agent-fixture": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `You are a weather-focused assistant. Be concise, accurate, and explicit about when you are using the local weather tool.
`,
    ),
    file(
      "agent/skills/get-weather.md",
      "markdown",
      `---
description: Use the weather tool before answering forecast or temperature questions.
---

When the user asks about weather, temperature, or forecast conditions, call the \`get_weather\` tool before answering.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export default defineTool({
  approval: never(),
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  async execute(input) {
    const city = input.city;

    await sleep(300);

    return {
      city,
      temperatureF: 72,
      condition: "Sunny",
      summary: \`Sunny in \${city} with a light breeze.\`,
    };
  },
});
`,
    ),
  ],
};
