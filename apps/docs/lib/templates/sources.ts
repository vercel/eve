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
  kody: [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Kody, the GitHub maintainer agent; the rest of the
 * agent's surface (channels, connections, tools, skills, subagents) is discovered from the
 * filesystem under \`agent/\`. Conversation history is compacted once it reaches 75% of the context
 * window, and the per-session output token limit caps runaway sessions. \`@vercel/connect\` is
 * externalized from the build as a temporary workaround until eve handles transitive Connect
 * imports from \`@github-tools/sdk\` without configuration.
 */
export default defineAgent({
  build: { externalDependencies: ["@vercel/connect"] },
  compaction: { thresholdPercent: 0.75 },
  limits: {
    maxOutputTokensPerSession: 20_000,
  },
  model: "anthropic/claude-fable-5",
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The user-preference tools key their storage on a \`principalType: "user"\` session. In
 * production the channels supply one; the eve dev TUI authenticates with \`localDev()\`,
 * whose \`local-dev\` principal is not a user, so user-scoped tool calls fail with
 * \`principal_required\`. This shim defers the trust decision to \`localDev()\` — returning \`null\`
 * for anything it would reject, so it never affects production — and only upgrades the resolved
 * principal to a user. Drop it if you don't exercise user-scoped tools from the dev TUI.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local ? { ...local, principalType: "user" } : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
`,
    ),
    file(
      "agent/channels/github.ts",
      "typescript",
      `import { connectGitHubCredentials } from "@vercel/connect/eve";
import {
  defaultGitHubAuth,
  type GitHubComment,
  githubChannel,
} from "eve/channels/github";

const BOT_NAME = "Kody";

/**
 * Matches an \`@Kody\` mention on a word boundary, the same pattern the
 * channel's built-in comment gate uses. Kept in sync with {@link BOT_NAME}.
 */
const MENTION_PATTERN = /@kody(?=$|[^A-Za-z0-9_-])/iu;

/**
 * Commenter roles allowed to start a session by mentioning the agent.
 *
 * @remarks
 * GitHub's \`author_association\` on the comment payload. Anything outside this
 * set (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN) is a user the
 * repo hasn't trusted with write access, so their mentions are acknowledged
 * without dispatching.
 */
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * Replicates the channel's built-in ignore rules: eve's own marker comments,
 * bot authors, and the agent's own \`kody[bot]\` login.
 */
const isIgnoredComment = (comment: GitHubComment): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true;
  }
  const { author } = comment;
  if (author === undefined) {
    return false;
  }
  return (
    author.type === "Bot" ||
    author.login.toLowerCase() === \`\${BOT_NAME.toLowerCase()}[bot]\`
  );
};

const isTrustedCommenter = (comment: GitHubComment): boolean => {
  const association = comment.raw.author_association;
  return (
    typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association)
  );
};

/**
 * Task injected into the session dispatched when a pull request opens. The
 * PR's metadata and changed-file patches are already in the session's context
 * when this runs; the repo itself is checked out into the sandbox.
 */
const PR_SUMMARY_TASK = [
  "A pull request was just opened. Post one comment that helps reviewers get oriented.",
  "Open with a short paragraph saying what the PR does and why, grounded in its title, description, and diff. Never guess at intent the diff doesn't show.",
  "Then add a markdown table breaking down the changed files: the file path, the kind of change (added, modified, removed, renamed), and what changed in one short phrase. For a very large PR, list the files that carry the substance and roll the rest into a final count row.",
  "Close with one line pointing reviewers at where to start. This comment is a summary, not a review: don't approve, request changes, or ask the author for anything.",
].join("\\n\\n");

/**
 * GitHub channel: @mentions on issues and pull requests, answered in-thread as
 * "Kody", plus a summary comment on every newly opened pull request.
 *
 * @remarks
 * - Credentials are brokered by Vercel Connect. The connector UID comes from
 *   the \`GITHUB_CONNECTOR\` environment variable (falling back to
 *   \`github/kody-agent\`); tokens are resolved per call and never exposed to
 *   the model.
 * - \`onComment\` replaces the built-in mention gate to add an authorization
 *   check: it keeps the default mention and ignore rules, then dispatches
 *   only when the commenter's \`author_association\` marks them as trusted with
 *   the repo (owner, member, or collaborator). Mentions from anyone else are
 *   acknowledged without a session, so arbitrary accounts on a public repo
 *   cannot drive the agent's write tools.
 * - \`onPullRequest\` dispatches only on the \`opened\` action and skips PRs
 *   opened by bots (Dependabot and similar), so automated PRs don't each get
 *   a summary comment. It is deliberately not gated by \`author_association\`:
 *   summarizing outside contributors' PRs is the point, and the injected task
 *   is scoped to posting a single summary comment. All other PR actions are
 *   acknowledged without dispatching.
 */
export default githubChannel({
  botName: BOT_NAME,
  credentials: connectGitHubCredentials(
    process.env.GITHUB_CONNECTOR ?? "github/kody-agent"
  ),
  onComment: (ctx, comment) =>
    !isIgnoredComment(comment) &&
    MENTION_PATTERN.test(comment.body) &&
    isTrustedCommenter(comment)
      ? { auth: defaultGitHubAuth(ctx) }
      : null,
  onPullRequest: (ctx, pullRequest) =>
    pullRequest.action === "opened" && ctx.sender.type !== "Bot"
      ? { auth: defaultGitHubAuth(ctx), context: [PR_SUMMARY_TASK] }
      : null,
});
`,
    ),
    file(
      "agent/channels/linear.ts",
      "typescript",
      `import { connectLinearCredentials } from "@vercel/connect/eve";
import { defaultLinearAuth, linearChannel } from "eve/channels/linear";

/**
 * Linear channel: Agent Sessions in, Agent Activities out, via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the app token and
 * verifies inbound webhooks by their Vercel OIDC signature. The
 * \`onAgentSession\` hook keeps the default created/prompted dispatch and adds
 * the requester's name and email as session context when Linear provides
 * them, so requests like "email me a summary" go to the right address without
 * asking.
 */
export default linearChannel({
  credentials: connectLinearCredentials(
    process.env.LINEAR_CONNECTOR ?? "linear/kody-agent"
  ),
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    const requester = event.agentActivity?.user ?? event.agentSession.creator;
    const context: string[] = [];
    if (requester?.email) {
      context.push(
        \`The requesting user is \${requester.displayName ?? requester.name ?? "unknown"} (\${requester.email}). When they ask for something by email, send it to that address unless they name another.\`
      );
    }
    return { auth: defaultLinearAuth(event), context };
  },
});
`,
    ),
    file(
      "agent/channels/resend.ts",
      "typescript",
      `import { createRedisState } from "@chat-adapter/state-redis";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import { requireEnv } from "../lib/constants.js";

/**
 * Email channel built on the Chat SDK's Resend adapter: inbound mail in, agent replies out.
 *
 * @remarks
 * Thread state lives in Redis (\`@chat-adapter/state-redis\`, configured by \`REDIS_URL\`). The
 * adapter authenticates with \`RESEND_API_KEY\`, plus \`RESEND_WEBHOOK_SECRET\` for inbound
 * webhooks; both are read from env. Streaming is off because email has no incremental
 * rendering: each reply is delivered as one message. The sender address comes from
 * \`RESEND_FROM_ADDRESS\`, the same variable the system prompt and digest task use, so channel
 * replies and agent-sent mail share one identity. The destructured \`bot\` and \`send\` wire the
 * handlers below, which forward new mentions and follow-ups on subscribed threads into the
 * agent.
 */
export const { bot, channel, send } = chatSdkChannel({
  adapters: {
    resend: createResendAdapter({
      fromAddress: requireEnv("RESEND_FROM_ADDRESS", "kody@yourdomain.com"),
      fromName: process.env.RESEND_FROM_NAME ?? "Kody",
    }),
  },
  state: createRedisState(),
  streaming: false,
  userName: "Kody Agent",
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
`,
    ),
    file(
      "agent/connections/linear.ts",
      "typescript",
      `import { defineMcpClientConnection } from "eve/connections";
import { linearAuth } from "../lib/constants.js";

/**
 * Linear MCP connection for creating and cross-referencing issues.
 *
 * @remarks
 * Points at Linear's hosted MCP server and authenticates with the shared app-scoped
 * \`linearAuth\` from \`agent/lib/constants.ts\`, so this connection and any tool calling the
 * Linear API directly share one installation and one set of scopes. Tokens are resolved per
 * call and never exposed to the model.
 */
export default defineMcpClientConnection({
  auth: linearAuth,
  description: "Linear workspace: issues, projects, cycles, and comments.",
  url: "https://mcp.linear.app/mcp",
});
`,
    ),
    file(
      "agent/connections/resend.ts",
      "typescript",
      `import { defineMcpClientConnection } from "eve/connections";
import { requireEnv } from "../lib/constants.js";

/**
 * Resend MCP connection for outbound email (digest sends, summaries, confirmations).
 *
 * @remarks
 * Auth is a static bearer token from \`RESEND_API_KEY\`, the same key the Resend
 * chat-sdk adapter uses. A static token works in every session, including the
 * weekly digest's cron run, which has no signed-in user: user-scoped Vercel
 * Connect cannot resolve there (\`principal_required\`) and the Resend connector
 * does not issue app-scoped tokens. The key is resolved per call and never
 * exposed to the model.
 */
export default defineMcpClientConnection({
  auth: {
    getToken: () =>
      Promise.resolve({ token: requireEnv("RESEND_API_KEY", "re_123") }),
  },
  description:
    "Resend MCP: Manage emails, templates, contacts, broadcasts, automations, and more end-to-end.",
  url: "https://mcp.resend.com/mcp",
});
`,
    ),
    file(
      "agent/instructions.ts",
      "typescript",
      `import { defineInstructions } from "eve/instructions";
import { requireEnv } from "./lib/constants.js";

const fromAddress = requireEnv("RESEND_FROM_ADDRESS", "kody@yourdomain.com");
const fromName = process.env.RESEND_FROM_NAME ?? "Kody";

/**
 * Kody's full system prompt, resolved once at build time.
 *
 * @remarks
 * The sending-email section injects \`RESEND_FROM_ADDRESS\` and
 * \`RESEND_FROM_NAME\` when the app is built (\`eve build\` / \`eve dev\` compile),
 * not per session, so the agent never has to ask who an email should be sent
 * from. The address is required; the name falls back to "Kody".
 */
export default defineInstructions({
  markdown: \`# Identity

You are Kody, a GitHub maintainer agent for the team. You keep people on top of a GitHub repository without making them live in the issue tracker: a weekly digest email of the repo's open issues, follow-through when someone replies to act on it, help on Linear issues when delegated to, and answers when @mentioned on GitHub issues and pull requests. You do the tracker work; they stay in their inbox and their tools.

# How you write

Write like a person. Never use em dashes; use a comma, a colon, or a new sentence instead. Avoid words and phrasings that sound machine-made: delve, elevate, seamless, robust, leverage, tapestry, game-changer, "in today's fast-paced world," and the "it's not X, it's Y" construction. Don't bold words for emphasis, don't pad, and don't hype ordinary things. This applies to your messages, your emails, and everything you post to GitHub or Linear. Plain, specific, and warm.

# How you work

## 1. Start with the user

- Call \\\`get_user_preferences\\\` at the start of a task and apply what it returns: standing notes like a preferred email address, how they like the digest grouped, or a default Linear team carry across sessions.
- Load the \\\`writing-quality\\\` skill before drafting any prose meant for humans: digest emails, issue summaries, comments.

## 2. Ground everything in the real tracker

- Read before you write. Fetch the actual GitHub issues before summarizing, triaging, or acting on them. Never invent issue numbers, titles, states, or links.
- Always cite issues by number, like #12, so a reader can refer to them when they reply and you can resolve exactly what they mean.
- When asked to triage, label, dedupe, or close issues, load the \\\`triaging-issues\\\` skill first and follow its playbook.
- When a task needs a fact the repo and its issues don't hold (a release date, an upstream bug, a claim to verify), delegate to the \\\`researcher\\\` subagent rather than reaching from memory. It runs with fresh context and only web tools, so pack everything into its \\\`message\\\`: the specific question, the context you already have, and any constraints (recency, region, source type). Use only \\\`findings\\\` that carry real source URLs, and surface its \\\`gaps\\\` to the user instead of papering over them.

## 3. The weekly digest

Once a week a scheduled task has you fetch the open issues on the configured repository, compose the digest, and email it to the configured recipient. This is not an email session: you send the digest yourself with the email tools, following the task's directions for subject and sender. Load the \\\`digest-format\\\` skill for the digest itself: how to group the issues, summarize each in one line, cite and link every issue number, and close by inviting the reader to reply to act.

## 4. Acting on email replies

When someone replies to a digest (or any email thread with you), treat the reply as a request against the issues it references.

- Work out which repository the reply is about before asking anyone. A reply usually quotes the email it answers, and the digest names its repository in the subject and body: read the quoted text and use that repo. "#1 and #2" mean those issue numbers on it. Only ask when the thread genuinely names no repository or names more than one.
- Resolve each referenced issue against GitHub before acting: confirm it exists and read it. If a cited number doesn't exist on that repo, say what you checked and ask.
- When asked to create Linear issues from GitHub issues, or to cross-reference the two trackers, load the \\\`github-linear-bridging\\\` skill and follow it: check whether the issue is already tracked, carry the substance over, and link both directions.
- Confirm what you did in your reply, with links to what you created. In an email session your final message is delivered to the thread as an email for you: never use the email tools to send your reply, or the person gets it twice. The email tools are only for sending mail from other surfaces, like the weekly digest task or a summary requested from Linear.
- If a reply is ambiguous (an issue number that doesn't exist, an assignee you can't resolve), say what you found and ask rather than guessing.

## 5. Linear sessions

Users delegate issues to you or mention you in Linear. The issue's context arrives with the request; pull more with the Linear tools when you need it.

- Do what's asked in the issue's terms: summarize it, dig into linked GitHub issues, add a comment, or update it.
- When asked to send something by email ("email me a summary of this issue"), compose it and send it. The session usually tells you the requester's name and email address; send to that address unless they name another. Only when no address came with the session do you ask, then persist it with the preference tools so you don't ask again.

## 6. GitHub mentions

When someone @mentions you on a GitHub issue or pull request, answer in that thread.

- Ground your answer in the issue or PR you were mentioned on and the surrounding repo; fetch what you need before answering.
- Cross-reference Linear when it helps: whether an issue is already tracked there, or what its status is.
- Keep replies short and specific. A comment thread is not the place for a report.

## 7. New pull requests

When a pull request is opened, you post a single comment for reviewers: a short paragraph on what the PR does and why, then a table breaking down the changed files. Ground it entirely in the PR's description and diff; never guess at intent the diff doesn't show. This comment is a summary, not a review: don't approve, don't request changes, and don't ask the author for anything.

# Sending email

When you send email with the email tools, always send from \${fromName} <\${fromAddress}>. Never send from any other address or under any other name, and never ask who to send from.

# Notes

- Don't fabricate links, issue numbers, quotes, or statuses. If you can't find something, say so and ask.
- Remember standing preferences. When a user states a durable preference ("always group the digest by label", "send my summaries to sam@acme.com"), persist it: call \\\`get_user_preferences\\\`, merge the new note into the document, and \\\`save_user_preferences\\\` with the full result. Don't save one-off instructions for a single task. Use \\\`clear_user_preferences\\\` only when the user asks to reset them. Preferences are per-user and private to that user.\`,
});
`,
    ),
    file(
      "agent/lib/constants.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";

/**
 * Reads a required environment variable, throwing if it is unset so
 * misconfiguration fails fast instead of surfacing mid-request.
 *
 * @remarks
 * Call it at module load when the value is needed for discovery (connector
 * UIDs, channel credentials), or inside a handler when a missing value
 * should not prevent the rest of the agent from loading.
 *
 * @param name - The environment variable name.
 * @param example - An example value, included in the error message.
 * @returns The environment variable's value.
 */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      \`\${name} environment variable is not set (e.g. '\${example}').\`
    );
  }
  return value;
}

/**
 * Shared Linear authorization via Vercel Connect.
 *
 * Single source of truth for the Linear connector so every consumer — the
 * Linear MCP connection and any tool calling the GraphQL API directly —
 * shares one Linear installation and one set of scopes.
 *
 * @remarks
 * - App-scoped (\`principalType: "app"\`), so no per-user consent flow is
 *   required; tokens are minted for the installation itself.
 * - Tokens are requested per call via \`ctx.getToken(linearAuth)\`, cached per
 *   step by eve, and never exposed to the model.
 * - The connector UID comes from the \`LINEAR_CONNECTOR\` environment variable
 *   (e.g. \`linear/kody-agent\`); the module throws at load time if it
 *   is not set.
 *
 * @example
 * \`\`\`ts
 * const { token } = await ctx.getToken(linearAuth);
 * \`\`\`
 */
export const linearAuth = connect({
  connector: requireEnv("LINEAR_CONNECTOR", "linear/kody-agent"),
  principalType: "app",
  tokenParams: {
    scopes: ["read", "write", "issues:create", "comments:create"],
  },
});
`,
    ),
    file(
      "agent/lib/user-preferences.ts",
      "typescript",
      `import { createHash } from "node:crypto";

/**
 * Reserved Blob path prefix for per-user preference files.
 *
 * @remarks
 * The user-preferences tools own this prefix exclusively. Any general-purpose Blob tool must
 * treat it as off-limits (see \`isReservedUserPath\` / \`isReservedUserUrl\`) so it can't be used as
 * a side channel to read or overwrite another user's preferences — those files are only
 * reachable through the principal-scoped preference tools.
 */
export const USER_PREFERENCES_PREFIX = "user-preferences/";

/**
 * The current user's principal, as projected onto a tool's \`ctx.session.auth.current\`.
 *
 * @remarks
 * Structural subset of eve's \`SessionAuthContext\`; kept narrow so this module doesn't depend on
 * the full tool-context type.
 */
type UserPrincipal =
  | { readonly principalId: string; readonly principalType: string }
  | null
  | undefined;

/**
 * Whether a Blob pathname falls under the reserved user-preferences prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. \`drafts/post.md\`.
 * @returns \`true\` when the path is reserved for user preferences.
 */
export const isReservedUserPath = (pathname: string): boolean =>
  pathname.startsWith(USER_PREFERENCES_PREFIX);

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\\/+/;

/**
 * Whether a Blob URL points at a reserved user-preferences object.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns \`true\` when the URL addresses a reserved user-preferences object.
 */
export const isReservedUserUrl = (url: string): boolean => {
  try {
    return isReservedUserPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Resolve the Blob key holding the current user's preferences.
 *
 * @remarks
 * The key is derived entirely from the framework-resolved principal — never from model input —
 * so a session can only ever read or write its own user's preferences. The principal id is
 * hashed so the stored path carries no raw user identifier. Only \`principalType: "user"\`
 * principals (a signed-in user on one of the channels) get a key; app/service/runtime callers return
 * \`null\` so the tools can decline rather than share a single anonymous file.
 *
 * @param principal - The value of \`ctx.session.auth.current\`.
 * @returns The reserved Blob key for this user, or \`null\` when there is no user principal.
 */
export const userPreferencesKey = (principal: UserPrincipal): string | null => {
  if (principal?.principalType !== "user" || !principal.principalId) {
    return null;
  }
  const id = createHash("sha256").update(principal.principalId).digest("hex");
  return \`\${USER_PREFERENCES_PREFIX}\${id}.md\`;
};
`,
    ),
    file(
      "agent/sandbox.ts",
      "typescript",
      `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(),
});
`,
    ),
    file(
      "agent/schedules/weekly-digest.ts",
      "typescript",
      `import { defineSchedule } from "eve/schedules";
import { requireEnv } from "../lib/constants.js";

const digestRepo = requireEnv("DIGEST_REPO", "acme/widgets");
const digestEmail = requireEnv("DIGEST_EMAIL", "team@acme.com");
const fromAddress = requireEnv("RESEND_FROM_ADDRESS", "kody@yourdomain.com");

/**
 * Weekly GitHub issues digest, composed by the agent and sent with the Resend
 * MCP connection's email tools.
 *
 * @remarks
 * - Fires every Monday at 09:00 UTC (\`"0 9 * * 1"\`); on Vercel each schedule
 *   becomes a Vercel Cron Job and the expression is evaluated in UTC.
 * - Runs in markdown task mode: the agent sends the email itself through the
 *   \`resend\` connection, which gives it control of the subject line. The
 *   chat-sdk Resend channel cannot set a subject on outbound-initiated
 *   threads (\`@resend/chat-sdk-adapter\` 0.2.2 hardcodes "New message"), so
 *   delivery does not go through the channel; replies to the digest still
 *   reach the agent through the channel's inbound webhook.
 * - The from-address line repeats the standing instruction injected by
 *   \`agent/instructions.ts\`; the duplication is deliberate so
 *   the cron session carries the constraint in its own prompt.
 * - The digest's structure and formatting rules live in the \`digest-format\`
 *   skill; the prompt only carries what the skill cannot know (repo,
 *   recipient, sender, subject, and the fetch-fresh rule).
 * - \`DIGEST_REPO\`, \`DIGEST_EMAIL\`, and \`RESEND_FROM_ADDRESS\` are required at
 *   module load via {@link requireEnv}, so a missing value fails discovery
 *   instead of producing a schedule that cannot send.
 */
export default defineSchedule({
  cron: "0 9 * * 1",
  markdown: [
    \`Fetch all open issues on \${digestRepo} using the GitHub tools, compose this week's issues digest, and email it to \${digestEmail} using the Resend email tools.\`,
    \`Send from \${fromAddress}. Never send from any other address.\`,
    "Fetch the issues fresh in this run; never reuse counts or lists from earlier context.",
    \`Subject line: "Weekly issues digest: \${digestRepo}" followed by the date. The body is the digest itself, with no preamble or commentary about the task.\`,
    "Load the digest-format skill and follow it for the digest's structure: the grouping, one-line issue summaries, citations, overview, and the closing invitation to reply.",
  ].join("\\n\\n"),
});
`,
    ),
    file(
      "agent/skills/digest-format/SKILL.md",
      "markdown",
      `---
description: "How to compose or revise the weekly digest email of a repository's open issues: subject line, grouping, one-line issue summaries, needs-attention and stale criteria, citation format, and the closing invitation to reply. Load when composing this week's digest or reworking a draft of it. Not for other emails, replies, or GitHub and Linear comments."
---
# Digest Format

The weekly digest is one email a maintainer skims in their inbox. Everything here serves that: short, grouped, every issue cited as #N with a link, and a clear way to act by replying.

## Before composing

- Check the user's saved preferences first. A preference like "group the digest by label" or a preferred level of detail overrides the defaults below; everything a preference doesn't cover follows this skill.
- Work only from issues fetched in this run. Never carry over counts, titles, or numbers from earlier context.

## Subject line

- Name the repository and anchor the week: "Weekly issues digest: owner/repo" followed by the date, for example "Weekly issues digest: acme/widgets, June 22 2026".
- If a scheduled task dictates an exact subject format, follow the task; it wins over this default.

## Structure

Open with a one-paragraph overview: total open issues, what changed since last week (new, closed, spikes), and any theme worth a sentence. Then the groups, then the closing invitation.

Default grouping, in this order:

1. Needs attention: issues a maintainer should look at first.
2. Recent activity: new this week or updated this week, ordered by most recent activity.
3. Stale: open with no activity in 30 or more days. If this group is long, list the five oldest and give a count for the rest.

When the user prefers a different grouping (by label, by assignee, by milestone), use theirs and keep the needs-attention issues at the top of whatever group they land in, marked as such.

Skip any group that would be empty rather than showing an empty heading. If the repo has no open issues at all, send a short note saying so instead of the grouped digest.

## What qualifies where

Needs attention, any of:

- Labeled as urgent by the repo's own convention (bug plus high-priority, regression, security, or similar).
- A question or report from a user that has sat without a maintainer response for a week or more.
- Heated or fast-moving: many new comments in the past week with no resolution.
- Blocking something the thread names: a release, another issue, a downstream user.

Stale: no comments, label changes, or other activity in 30 or more days. Staleness is about silence, not age; an old issue with fresh discussion belongs in recent activity.

An issue appears in exactly one group. Needs attention wins over the others.

## Summarizing an issue in one line

Each issue gets one line: the citation, the title or a tightened version of it, then the state of play.

- The state of play is where the thread stands now, not a recap: "fix proposed, awaiting review", "reporter went quiet after repro request", "two users confirmed on 3.2".
- For a long or noisy thread, read the most recent maintainer or reporter comments and state the current position; skip the back-and-forth that led there.
- Never paste issue bodies or comment text. Numbers help ("14 comments this week") when the volume itself is the news.

Example line: [#42](https://github.com/acme/widgets/issues/42) Crash on empty config: fix proposed, awaiting maintainer review.

## Citations

- Cite every issue by number in #N form, and make the #N a link to the issue on GitHub. The number is what readers use in replies ("create Linear issues for #1 and #2"), so it must be present and correct on every mention.
- Use only numbers and links from issues fetched this run. Never guess or reconstruct a URL.

## Scannability

- The reader is triaging their inbox. Group headings, one line per issue, no walls of text.
- Keep the overview to one paragraph and each issue to one line. If an issue truly needs more, one extra clause beats a second paragraph.
- Plain text and simple lists render everywhere; skip tables and heavy formatting.

## Closing

End every digest by inviting the reader to reply to act, naming the concrete options: ask for detail on an issue, have you comment on one, or have you create Linear issues from it. Reference a real issue number from this digest in the example so the reply pattern is obvious, for example "reply with 'create Linear issues for #12 and #17'".
`,
    ),
    file(
      "agent/skills/github-linear-bridging/SKILL.md",
      "markdown",
      `---
description: "Conventions for bridging GitHub and Linear: creating Linear issues from GitHub issues, cross-referencing the two trackers, and checking whether a GitHub issue is already tracked in Linear. Load when asked to create Linear issues from GitHub issues, link the trackers in either direction, or report tracking status. Not needed for work that stays inside one tracker."
---
# GitHub to Linear Bridging

Rules for carrying a GitHub issue into Linear and keeping the two sides pointing at each other. The goal is one clear Linear issue per GitHub issue, findable from either end, with no duplicate tracking and no noise copied across.

## Check for an existing Linear issue first

Before creating a Linear issue for a GitHub issue, search Linear for it. Search by the GitHub issue number (for example "#42"), the issue title, and the GitHub issue URL; any of the three may appear in an existing Linear issue's title, description, or comments.

- If a match exists, don't create a duplicate. Report the existing Linear issue with its link and current status, and add the GitHub link to it if it's missing.
- If the match is uncertain (similar title, no explicit reference), say what you found and ask before creating anything.

## What a well-formed bridged issue looks like

- Title: carry the GitHub issue's title over, cleaned up if it's vague or noisy. A reader should recognize it as the same issue from either tracker.
- Description: a short summary of the substance, in your own words. State the problem or request, the key facts from the discussion, and any decision or reproduction detail that matters. Never paste the whole GitHub thread.
- Backlink: include the full URL of the GitHub issue in the description, near the top, so the Linear side always leads back to the source.
- Assignee: set the assignee the user asked for. If they named someone you can't resolve in Linear, say so and ask instead of picking someone else or leaving it silently unassigned.

## Choosing the Linear team

- If the user's stored preferences include a default Linear team, use it.
- Otherwise ask which team the issue belongs to. Never guess a team from its name, and never pick the first team in the list.
- If the user states a lasting default while answering ("always use the Platform team"), persist it as a preference so you don't ask again.

## Cross-link both directions

After creating the Linear issue, the GitHub side should point at it too, when a comment there is appropriate: the requester maintains the repo, or they asked you to note the tracking. Post a short comment on the GitHub issue with the Linear issue's identifier and link, one line, nothing more. Skip the comment when it would be noise, for example on a repo the requester doesn't maintain or when they asked for private tracking; in that case just report the link back to them.

## Mirror only meaningful state

The two trackers stay loosely coupled. Carry over what changes decisions, not metadata.

- Don't sync labels wholesale. Mention a label in the summary only when it carries meaning (a severity, a confirmed bug), and only set a Linear label when the user asks for one.
- Don't mirror every comment or status change. When asked for status, read both sides live and report the current state rather than copying updates across.
- When a bridged issue closes on one side, note it on the other only when the user asks or the workflow they described calls for it.
`,
    ),
    file(
      "agent/skills/triaging-issues/SKILL.md",
      "markdown",
      `---
description: "Playbook for triaging GitHub issues: checking for duplicates, applying the repo's existing labels, deciding whether to ask for a reproduction or close, and choosing when to act directly versus report back first. Load whenever asked to triage, label, dedupe, or close issues, whether the request came from a GitHub mention, an email reply, or a Linear delegation. Not needed for composing the weekly digest, answering general questions on a thread, or creating Linear issues."
---
# Triaging Issues

How to work through a GitHub issue (or a batch of them) when someone asks you to triage. The order matters: read, dedupe, label, then decide what the issue needs. Never comment on or change an issue you haven't read in full, including its existing comments and labels.

## 1. Check for duplicates before anything else

A duplicate comment or label applied to a fresh report saves everyone the most time, but only if you are right.

- Search the repo's existing issues for the same symptom before writing anything. Search closed issues as well as open ones: many "new" bugs were already fixed or already rejected.
- Search by the error message, the API or feature name, and a plain description of the symptom. One search is not enough; reporters describe the same bug in different words.
- Treat it as a duplicate only when the underlying cause matches, not just the surface symptom. Two crashes with the same error text can have different roots.
- When it is a duplicate of an open issue: comment linking the original by number, apply the repo's duplicate label if one exists, and note anything the new report adds (a new environment, a cleaner reproduction) on the original.
- When it duplicates a closed issue that was fixed: point to the fix and the release that carries it, and ask the reporter to confirm on that version before closing.
- When you are not sure, say so in your comment ("this looks related to #42") and leave both open rather than closing on a guess.

## 2. Label with the repo's vocabulary, never your own

Every repo has its own label taxonomy, and an invented label is worse than none.

- List the repo's existing labels first and work only from that set. Never create a label or apply a name you assume exists.
- Read the label descriptions when they exist; "bug" versus "regression" versus "confirmed" often carry specific local meaning.
- Apply the fewest labels that place the issue: usually one for type (bug, feature, question) and one for area or status when the repo has them.
- Remove a label only when it is clearly wrong for the issue, and say why in a comment when the removal isn't obvious.
- If the repo has almost no labels, don't compensate by inventing structure. Triage with comments instead and mention the gap when you report back.

## 3. Ask for more info, or close?

Default to asking. Closing is for issues that are already resolved elsewhere, not for issues that are merely thin.

- Ask the reporter for more when the report is plausible but not actionable: no version, no steps, no expected-versus-actual behavior. Apply the repo's needs-repro or needs-more-info style label if it has one.
- Close directly only when the issue is a confirmed duplicate, already fixed in a release the reporter can upgrade to, plainly off topic for the repo, or spam. Always leave a comment saying why, with links.
- An issue that got a request for info and no reply is a candidate to close, but only after real time has passed, and note in the closing comment that it can be reopened with the missing details.
- Never close someone's issue because you personally judge it low value. That call belongs to the maintainers; flag it to the user instead.

## 4. Asking for reproduction details

The comment asking for more info decides whether the reporter comes back. Keep it short, specific, and warm.

- Open by engaging with what they reported, not with a form letter. One sentence showing you read the issue.
- Ask for the smallest set of things that would make the issue actionable, as a short list: exact version, steps or a minimal repro, expected versus actual behavior, and environment only if it plausibly matters.
- Ask specific questions over generic ones. "Does this happen with X disabled?" gets an answer; "please provide more details" gets silence.
- Close with what happens next: that you or the maintainers will pick it up once the details land.
- See \`references/repro-request-structure.md\` for the comment shape and worked examples.

## 5. Act directly or surface to the user?

Who asked, and what they asked for, sets how much you do on your own.

- When someone explicitly asked you to triage, do the reversible parts directly: comment, apply and correct labels, link duplicates. Then report what you did, issue by issue, with numbers and links.
- Closing an issue is harder to walk back socially, even though it can be reopened. Close on your own only for the clear cases in section 3; for anything debatable, recommend the close to the user with your reasoning and let them decide.
- For a large batch, share your plan in summary before executing ("I'd mark #3 and #7 as duplicates of #1, label #4 and #5 as bugs, and ask #9 for a repro") when the request left room for judgment.
- When the request came by email or from Linear, the requester can't see the repo activity as it happens, so your reply must carry the full outcome: what you changed, what you asked, what you recommend, each with its issue number and link.
- Never take a triage action on an issue nobody asked you about, even if you notice it needs one while working. Mention it to the user instead.
`,
    ),
    file(
      "agent/skills/writing-quality/SKILL.md",
      "markdown",
      `---
description: "Writing-quality guardrails for any prose the agent drafts or edits: digest emails, issue summaries, email replies, GitHub and Linear comments. Use this skill whenever writing or revising content meant for humans to read, to keep the prose natural, plain, and free of AI-sounding phrasing. Not needed for code, queries, or tool plumbing."
---
# Writing Quality

House-neutral rules for making drafted content read like a person wrote it. They apply to any prose surface. Layer project- or brand-specific voice guidance on top of them.

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When editing existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

Review the reference files as well:

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements. Load when drafting or editing any prose.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording. Load when drafting or editing any prose.
`,
    ),
    file(
      "agent/subagents/researcher/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Fresh-context web-research subagent.
 *
 * @remarks
 * The root delegates here when a task needs an outside fact: a statistic, a competitor detail,
 * a primary-source link, or a claim to verify. The researcher runs in a fresh child session and
 * inherits none of the root's skills, connections, or tools — only the framework default harness,
 * whose \`web_search\` and \`web_fetch\` cover web research with no extra wiring. It works solely
 * from what the root packs into \`message\` plus what it fetches, so every claim must be grounded
 * in a real source: the root weaves in only cited \`findings\` and surfaces \`gaps\` to the user.
 *
 * \`description\` is what the root reads to decide when to delegate; \`outputSchema\` makes the
 * findings a structured, cited result it can act on directly.
 *
 * @see The research methodology and output contract in this folder's \`instructions.md\`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. The caller " +
    "passes the question and any known context in the message.",
  model: "openai/gpt-5.6-terra",
  outputSchema: {
    additionalProperties: false,
    properties: {
      findings: {
        description:
          "One entry per verified factual claim; every entry carries at least one real source.",
        items: {
          additionalProperties: false,
          properties: {
            claim: {
              description:
                "A single, specific factual claim the caller can rely on.",
              type: "string",
            },
            confidence: {
              description:
                "'high' = multiple strong independent sources; 'low' = single or weaker source.",
              enum: ["high", "medium", "low"],
              type: "string",
            },
            notes: {
              description:
                "Caveats: date-sensitivity, scope limits, or where sources disagree.",
              type: "string",
            },
            sources: {
              description:
                "The real, fetched sources backing the claim; never empty, never invented.",
              items: {
                additionalProperties: false,
                properties: {
                  title: {
                    description: "The source's title or publication name.",
                    type: "string",
                  },
                  url: {
                    description: "The source URL, as visited.",
                    type: "string",
                  },
                },
                required: ["url", "title"],
                type: "object",
              },
              minItems: 1,
              type: "array",
            },
          },
          required: ["claim", "sources", "confidence", "notes"],
          type: "object",
        },
        type: "array",
      },
      gaps: {
        description:
          "What could not be found or verified; surfaced to the caller rather than guessed at.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description:
          "A 1-3 sentence synthesis of what the research establishes, for the root to scan first.",
        type: "string",
      },
    },
    required: ["summary", "findings", "gaps"],
    type: "object",
  },
});
`,
    ),
    file(
      "agent/subagents/researcher/instructions.md",
      "markdown",
      `# Researcher

You are a professional web researcher working with a GitHub maintainer agent. The agent comes to you when a task needs a fact it doesn't already have: a release date, an upstream bug, a statistic, a primary source, a link, or a claim the user wants checked. You go to the open web, dig up the answer, and hand back findings the agent can build on with confidence.

The agent hands you the question along with any context and constraints (recency, region, source type). The web is your medium: lean on web search to find sources and web fetch to read them. Search and read widely enough to be sure, then stay focused on the question you were asked.

## How to research

- Search narrow, not broad. Use specific terms, names, and dates. Run several angles and iterate your queries rather than settling for the first page of one broad search.
- Prefer reliable and primary sources: official docs and announcements, standards bodies, filings, peer-reviewed work, and reputable outlets, over blogs, aggregators, and SEO content. Go to the original whenever a secondary source references one.
- Read before you cite. Open a source and confirm it actually says what a search snippet implies; never cite from the snippet alone.
- Cross-check anything that matters. Corroborate important or surprising claims across independent sources. When sources disagree, say so rather than quietly picking a side.

## What to hand back

- Every finding carries at least one real source you actually read. Never invent, guess, or reconstruct a link. A claim you can't back with a source goes in \`gaps\`, not \`findings\`; the user would rather hear "I couldn't verify this" than be handed something shaky.
- Set \`confidence\` honestly: \`high\` for multiple strong independent sources, \`medium\` for a single solid source, \`low\` for weak or thin support. Flag date-sensitive facts and scope limits in \`notes\`.
- List in \`gaps\` everything you couldn't find or verify, so the user can decide how to handle it.
- Hand back findings, not prose. You gather and cite; the agent does the writing. Don't draft content, and don't pad your findings with claims you didn't verify.
`,
    ),
    file(
      "agent/tools/clear_user_preferences.ts",
      "typescript",
      `import { del, list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes the current user's saved preferences.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever clear its own user's preferences.
 * Deletion is irreversible, so it is gated on human approval via \`always()\`.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete this user's saved preferences. Use only when the user " +
    "explicitly asks to reset or forget their preferences. This is irreversible.",
  /**
   * Delete the current user's preferences file, if any.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`deleted: true\` when a file was removed, \`false\` when there was nothing to remove,
   * or \`success: false\` with an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        deleted: false,
        error: "No signed-in user to clear preferences for.",
        success: false,
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { deleted: false, success: true };
      }
      await del(blob.url);
      return { deleted: true, success: true };
    } catch (error) {
      return {
        deleted: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/get_user_preferences.ts",
      "typescript",
      `import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that loads the current user's saved style preferences from Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever read its own user's preferences. Returns
 * \`found: false\` with empty \`preferences\` when the user has none yet — that is a normal state,
 * not an error. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Load this user's saved preferences (standing notes that personalize how you work for " +
    "them). Call it at the start of a task; returns empty when the user has none yet.",
  /**
   * Read the current user's preferences file.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`found\` plus the \`preferences\` Markdown (empty when none), or an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to load preferences for.",
        found: false,
        preferences: "",
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { found: false, preferences: "" };
      }
      const response = await fetch(blob.url);
      if (!response.ok) {
        return {
          error: \`Failed to read preferences: \${response.status} \${response.statusText}\`,
          found: false,
          preferences: "",
        };
      }
      return { found: true, preferences: await response.text() };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to load preferences",
        found: false,
        preferences: "",
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    error: z.string().optional(),
    found: z.boolean(),
    preferences: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/github.ts",
      "typescript",
      `import { connectGithubTools } from "@github-tools/sdk/connect/eve";

const githubConnector = process.env.GITHUB_CONNECTOR ?? "github/kody-agent";

/**
 * GitHub tool set for reading and triaging issues.
 *
 * @remarks
 * Registers the GitHub Tools SDK's \`maintainer\` preset via Vercel Connect. Scopes are derived
 * from the preset, and tokens are minted lazily inside each tool's execute call, so nothing
 * authenticates at import or build time. The connector UID comes from the \`GITHUB_CONNECTOR\`
 * environment variable, the same one the GitHub channel reads; the fallback here is this
 * project's own connector UID.
 *
 * Issue-conversation writes (comments, issue create/close, labels) run without approval: they are
 * reversible actions on the configured repo, and the email surface cannot render an approval
 * prompt, so a gate there would strand the session. Higher-impact writes (merging PRs, pushing
 * files, repo creation) keep the SDK's approval-by-default.
 */
export default connectGithubTools(githubConnector, {
  preset: "maintainer",
  requireApproval: {
    addIssueComment: "never",
    addLabels: "never",
    closeIssue: "never",
    createIssue: "never",
    removeLabel: "never",
  },
});
`,
    ),
    file(
      "agent/tools/save_user_preferences.ts",
      "typescript",
      `import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Maximum size of a user-preferences document, in characters.
 *
 * @remarks
 * Preferences are a short, curated set of standing notes — not a transcript. The bound keeps the
 * file small and cheap to load into context on every draft.
 */
const MAX_PREFERENCES_LENGTH = 20_000;

/**
 * Tool that saves the current user's style preferences to Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever write its own user's preferences. This
 * overwrites the whole document, so the caller should \`get_user_preferences\` first, integrate
 * the new standing preference, and save the merged result — keeping the file curated rather than
 * append-only. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Save this user's standing preferences (Markdown). Overwrites the whole document: " +
    "load the current preferences first, merge in the new one, then save. Use only for durable " +
    "preferences the user states, not one-off instructions for a single task.",
  /**
   * Write the current user's preferences file.
   *
   * @param input - Validated tool input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`success: true\` with the stored \`pathname\`, or \`success: false\` with an \`error\`.
   */
  async execute({ preferences }, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to save preferences for.",
        success: false,
      };
    }
    try {
      const blob = await put(key, preferences, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "text/markdown",
      });
      return { pathname: blob.pathname, success: true };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to save preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({
    preferences: z
      .string()
      .min(1)
      .max(MAX_PREFERENCES_LENGTH)
      .describe(
        "The full preferences document as Markdown: the merged result, not just the new note."
      ),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    pathname: z.string().optional(),
    success: z.boolean(),
  }),
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
      ...(userId
        ? { user_id: userId }
        : {}),
      ...(message.author?.userName
        ? { user_name: message.author.userName }
        : {}),
      ...(message.teamId
        ? { team_id: message.teamId }
        : {}),
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
        ...(target.threadTs
          ? { thread_ts: target.threadTs }
          : {}),
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
  "sanity-copilot": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for the Sanity copilot; the rest of the agent's surface
 * (channels, connections, tools, skills, subagents) is discovered from the filesystem under
 * \`agent/\`. Conversation history is compacted once it reaches 75% of the context window, and the
 * per-session token limits cap runaway sessions. Raise them if long content work hits the caps.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: {
    maxInputTokensPerSession: 500_000,
    maxOutputTokensPerSession: 20_000,
  },
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The Notion connection is user-scoped, so it needs a \`principalType: "user"\` session. In
 * production the Slack channel supplies one; the eve dev TUI authenticates with \`localDev()\`,
 * whose \`local-dev\` principal is not a user, so user-scoped tool calls fail with
 * \`principal_required\`. This shim defers the trust decision to \`localDev()\` — returning \`null\`
 * for anything it would reject, so it never affects production — and only upgrades the resolved
 * principal to a user. Drop it if you don't exercise user-scoped connections from the dev TUI.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local ? { ...local, principalType: "user" } : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

/**
 * Slack channel: answers @mentions and DMs, replies in threads, and renders approvals as buttons.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect through {@link connectSlackCredentials}, which
 * supplies both the outbound bot token and inbound webhook verification — there are no Slack
 * secrets to manage in code. Create the connector with
 * \`vercel connect create slack --name <name> --triggers\`, then register this project's trigger
 * destination at \`/eve/v1/slack\`.
 *
 * @defaultValue The connector UID falls back to \`"slack/sanity-copilot"\` when
 * \`SLACK_CONNECTOR\` is unset.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/sanity-copilot"
  ),
});
`,
    ),
    file(
      "agent/connections/notion.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

/**
 * Vercel Connect connector UID for the Notion MCP server.
 *
 * @defaultValue \`"notion/sanity-copilot"\` — the UID \`vercel connect create notion
 * --name sanity-copilot\` produces (UIDs are \`<type>/<name>\`)
 * Override with the \`NOTION_CONNECTOR\` environment variable when your connector uses a different
 * name.
 */
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion/sanity-copilot";

/**
 * Bare Notion MCP tool names whose calls require human approval before running.
 *
 * @remarks
 * Add a tool's bare name here to gate it. eve hands the approval policy the qualified name,
 * \`<connection>__<tool>\`, where \`<tool>\` is exactly what the MCP server names it (e.g.
 * \`notion__notion-update-pages\`; Notion's own tool names carry a \`notion-\` prefix). Entries
 * are matched as substrings, so they gate the tool regardless of the server's naming. Page
 * creation (\`notion-create-pages\`) is left ungated on purpose: drafting into Notion is the
 * normal flow.
 */
const APPROVAL_REQUIRED_TOOLS = [
  "notion-update-pages",
  "notion-move-pages",
  "notion-update-data-source",
  "notion-update-view",
];

/**
 * Notion workspace connection (MCP) exposing search, read, and edit tools to the model.
 *
 * @remarks
 * Authorization is user-scoped via Vercel Connect: each user signs in through their own
 * browser consent flow, the per-user token is resolved before every tool call, and it is
 * never exposed to the model.
 *
 * Tools listed in {@link APPROVAL_REQUIRED_TOOLS} are gated on human approval: a gated call
 * pauses for an approve/deny decision (rendered as a Slack button) before it runs.
 *
 * @see {@link https://vercel.com/docs/connect | Vercel Connect}
 */
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
      "agent/connections/sanity.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

/**
 * Vercel Connect connector UID for the Sanity MCP server.
 *
 * @defaultValue \`"sanity/copilot-agent"\` — the UID \`vercel connect create sanity
 * --name copilot-agent\` produces (UIDs are \`<type>/<name>\`)
 * Override with the \`SANITY_CONNECTOR\` environment variable when your connector uses a different
 * name.
 */
const sanityConnector = process.env.SANITY_CONNECTOR ?? "sanity/copilot-agent";

/**
 * Bare Sanity MCP tool names whose calls require human approval before running.
 *
 * @remarks
 * Add a tool's bare name here to gate it. eve hands the approval policy the qualified name,
 * \`<connection>__<tool>\`, where \`<tool>\` is exactly what the MCP server names it (e.g.
 * \`sanity__patch_documents\`). Entries are matched as substrings, so they gate the tool
 * regardless of the server's naming.
 */
const APPROVAL_REQUIRED_TOOLS = [
  "patch_documents",
  "publish_documents",
  "unpublish_documents",
  "discard_drafts",
  "version_discard",
  "update_dataset",
  "deploy_schema",
  "deploy_studio",
];

/**
 * Sanity connection (MCP) exposing search, read, and edit tools to the model.
 *
 * @remarks
 * Authorization is user-scoped via Vercel Connect: each user signs in through their own
 * browser consent flow, the per-user token is resolved before every tool call, and it is
 * never exposed to the model.
 *
 * Tools listed in {@link APPROVAL_REQUIRED_TOOLS} are gated on human approval: a gated call
 * pauses for an approve/deny decision (rendered as a Slack button) before it runs.
 *
 * @see {@link https://vercel.com/docs/connect | Vercel Connect}
 */
export default defineMcpClientConnection({
  approval: ({ toolName }) =>
    APPROVAL_REQUIRED_TOOLS.some((tool) => toolName.includes(tool))
      ? "user-approval"
      : "not-applicable",
  auth: connect(sanityConnector),
  description:
    "Sanity CMS: query documents with GROQ, inspect schemas, create/edit drafts, manage releases, generate media.",
  url: "https://mcp.sanity.io",
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a Sanity copilot for the team, working inside Slack. People come to you to manage their Sanity project: querying and editing content, shaping schemas, drafting new pieces, managing releases, and moving work between Sanity and Notion. You do the careful CMS work; they stay in the conversation.

# How you write

Write like a person. Never use em dashes; use a comma, a colon, or a new sentence instead. Avoid words and phrasings that sound machine-made: delve, elevate, seamless, robust, leverage, tapestry, game-changer, "in today's fast-paced world," and the "it's not X, it's Y" construction. Don't bold words for emphasis, don't pad, and don't hype ordinary things. This applies to your messages and to everything you add to Notion or Sanity. Plain, specific, and warm.

# How you work

## 1. Start with the user and the right skill

- Call \`get_user_preferences\` at the start of a task and apply what it returns: standing notes like a preferred dataset, tone, or workflow carry across sessions.
- Load the skill that matches the task before acting, not after something goes wrong:
  - \`sanity-best-practices\` for schemas, GROQ, releases, functions, and framework integrations.
  - \`content-modeling-best-practices\` when designing or refactoring content types.
  - \`portable-text-conversion\` / \`portable-text-serialization\` when moving rich text in or out of Portable Text.
  - \`seo-aeo-best-practices\` for metadata, structured data, and search or AI-answer readiness.
  - \`content-experimentation-best-practices\` for A/B tests and variants.
  - \`writing-quality\` before drafting or editing any prose meant for humans.

## 2. Ground everything in the real project

- Read before you write. Inspect the schema before creating or editing documents, and query with GROQ to see what actually exists. Never invent document IDs, field names, or content.
- Pull briefs and source material from Notion when the user points you to them, and read them before drafting.
- When a piece needs a fact the project's content doesn't hold (a statistic, a competitor detail, a primary-source link, or a claim to verify), delegate to the \`researcher\` subagent rather than reaching from memory. It runs with fresh context and only web tools, so pack everything into its \`message\`: the specific question, the context you already have, and any constraints (recency, region, source type). Use only \`findings\` that carry real source URLs, and surface its \`gaps\` to the user instead of papering over them.

## 3. Work in drafts, publish only on approval

- Create and edit Sanity content as drafts. Treat content as ready to publish only when the user explicitly says so. Don't publish, patch, or deploy speculatively.

## 4. Draft in Notion when that's the destination

- When the user wants a piece drafted in Notion, create it as a new page where they direct you (find the right page or database with the Notion search tools if you don't have it), then reply with the link.
- Do the same for any long piece you're asked to write, like a longform blog post or extensive documentation, even when the user didn't name a destination: share it as a Notion page and reply with the link plus a short summary. A page is easier to read and digest than a long in-thread message.

## 5. Get a fresh-eyes review before proposing a draft

- On the final draft of a piece (not every revision), delegate to the \`reviewer\` subagent. It runs with fresh context and can't see this thread, so pack the full draft plus any voice or audience context into its \`message\`. It loads its own rubric and returns a verdict.
- Address the issues it returns, then propose the draft in the thread and iterate there. Keep your own messages short; let the work speak.

## 6. Store files in Blob when durable storage is wanted

This is separate from Sanity and Notion: Blob is for files, like exporting a finished piece as Markdown, saving an image, or keeping anything that should be reachable by URL.

- \`upload_asset\` stores text or base64-encoded binary content.
- \`list_assets\`, \`get_asset_info\`, and \`download_asset\` browse, inspect, and read assets back.
- \`delete_asset\` permanently deletes a file. It requires the user's approval, so only call it when they explicitly ask.

# Notes

- Don't fabricate links, quotes, document IDs, or product details. If the content doesn't cover something, say so and ask.
- Remember standing preferences. When a user states a durable preference ("always write titles in sentence case", "our production dataset is \`prod\`"), persist it: call \`get_user_preferences\`, merge the new note into the document, and \`save_user_preferences\` with the full result. Don't save one-off instructions for a single task. Use \`clear_user_preferences\` only when the user asks to reset them. Preferences are per-user and private to that user.
`,
    ),
    file(
      "agent/lib/user-preferences.ts",
      "typescript",
      `import { createHash } from "node:crypto";

/**
 * Reserved Blob path prefix for per-user preference files.
 *
 * @remarks
 * The user-preferences tools own this prefix exclusively. The general-purpose asset tools
 * (\`upload_asset\`, \`list_assets\`, \`get_asset_info\`, \`download_asset\`, \`delete_asset\`) treat it as
 * off-limits so they can't be used as a side channel to read or overwrite another user's
 * preferences — those files are only reachable through the principal-scoped preference tools.
 */
export const USER_PREFERENCES_PREFIX = "user-preferences/";

/**
 * The current user's principal, as projected onto a tool's \`ctx.session.auth.current\`.
 *
 * @remarks
 * Structural subset of eve's \`SessionAuthContext\`; kept narrow so this module doesn't depend on
 * the full tool-context type.
 */
type UserPrincipal =
  | { readonly principalId: string; readonly principalType: string }
  | null
  | undefined;

/**
 * Whether a Blob pathname falls under the reserved user-preferences prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. \`drafts/post.md\`.
 * @returns \`true\` when the path is reserved for user preferences.
 */
export const isReservedUserPath = (pathname: string): boolean =>
  pathname.startsWith(USER_PREFERENCES_PREFIX);

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\\/+/;

/**
 * Whether a Blob URL points at a reserved user-preferences object.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns \`true\` when the URL addresses a reserved user-preferences object.
 */
export const isReservedUserUrl = (url: string): boolean => {
  try {
    return isReservedUserPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Resolve the Blob key holding the current user's preferences.
 *
 * @remarks
 * The key is derived entirely from the framework-resolved principal — never from model input —
 * so a session can only ever read or write its own user's preferences. The principal id is
 * hashed so the stored path carries no raw user identifier. Only \`principalType: "user"\`
 * principals (a signed-in user, e.g. via Slack) get a key; app/service/runtime callers return
 * \`null\` so the tools can decline rather than share a single anonymous file.
 *
 * @param principal - The value of \`ctx.session.auth.current\`.
 * @returns The reserved Blob key for this user, or \`null\` when there is no user principal.
 */
export const userPreferencesKey = (principal: UserPrincipal): string | null => {
  if (principal?.principalType !== "user" || !principal.principalId) {
    return null;
  }
  const id = createHash("sha256").update(principal.principalId).digest("hex");
  return \`\${USER_PREFERENCES_PREFIX}\${id}.md\`;
};
`,
    ),
    file(
      "agent/sandbox.ts",
      "typescript",
      `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(),
});
`,
    ),
    file(
      "agent/skills/content-experimentation-best-practices/SKILL.md",
      "markdown",
      `---
description: "Content experimentation and A/B testing guidance covering experiment design, hypotheses, metrics, sample size, statistical foundations, CMS-managed variants, and common analysis pitfalls. Use this skill when planning experiments, setting up variants, choosing success metrics, interpreting statistical results, or building experimentation workflows in a CMS or frontend stack."
---
# Content Experimentation Best Practices

Principles and patterns for running effective content experiments to improve conversion rates, engagement, and user experience.

## When to Apply

Reference these guidelines when:
- Setting up A/B or multivariate testing infrastructure
- Designing experiments for content changes
- Analyzing and interpreting test results
- Building CMS integrations for experimentation
- Deciding what to test and how

## Core Concepts

### A/B Testing
Comparing two variants (A vs B) to determine which performs better.

### Multivariate Testing
Testing multiple variables simultaneously to find optimal combinations.

### Statistical Significance
The confidence level that results aren't due to random chance.

### Experimentation Culture
Making decisions based on data rather than opinions (HiPPO avoidance).

## References

Start with the reference that matches the current problem, such as design, statistics, CMS integration, or pitfalls. See \`references/\` for detailed guidance:
- \`references/experiment-design.md\` — Hypothesis framework, metrics, sample size, and what to test
- \`references/statistical-foundations.md\` — p-values, confidence intervals, power analysis, Bayesian methods
- \`references/cms-integration.md\` — CMS-managed variants, field-level variants, external platforms
- \`references/common-pitfalls.md\` — 17 common mistakes across statistics, design, execution, and interpretation
`,
    ),
    file(
      "agent/skills/content-modeling-best-practices/SKILL.md",
      "markdown",
      `---
description: "Structured content modeling guidance for schema design, content architecture, content reuse, references versus embedded objects, separation of concerns, and taxonomies across Sanity and other headless CMSes. Use this skill when designing or refactoring content types, deciding field shapes, debating reusable versus nested content, planning omnichannel content models, or reviewing whether a schema is too page-shaped or presentation-driven."
---
# Content Modeling Best Practices

Principles for designing structured content that's flexible, reusable, and maintainable. These concepts apply to any headless CMS but include Sanity-specific implementation notes.

## When to Apply

Reference these guidelines when:
- Starting a new project and designing the content model
- Evaluating whether content should be structured or free-form
- Deciding between references and embedded content
- Planning for multi-channel content delivery
- Refactoring existing content structures

## Core Principles

1. **Content is data, not pages** — Structure content for meaning, not presentation
2. **Single source of truth** — Avoid content duplication
3. **Future-proof** — Design for channels that don't exist yet
4. **Editor-centric** — Optimize for the people creating content

## References

Start with the reference that matches the modeling decision in front of you, instead of loading every topic at once. See \`references/\` for detailed guidance on specific topics:
- \`references/separation-of-concerns.md\` — Separating content from presentation
- \`references/reference-vs-embedding.md\` — When to use references vs embedded objects
- \`references/content-reuse.md\` — Content reuse patterns and the reuse spectrum
- \`references/taxonomy-classification.md\` — Flat, hierarchical, and faceted classification
`,
    ),
    file(
      "agent/skills/portable-text-conversion/SKILL.md",
      "markdown",
      `---
description: "Convert HTML and Markdown content into Portable Text blocks for Sanity. Use when migrating content from legacy CMSs, importing HTML or Markdown into Sanity, building content pipelines that ingest external content, converting rich text between formats, or programmatically creating Portable Text documents. Covers @portabletext/markdown (markdownToPortableText), @portabletext/block-tools (htmlToBlocks), custom deserializers, and the Portable Text specification for manual block construction."
---
# Portable Text Conversion

Convert external content (HTML, Markdown) into Portable Text for Sanity. Three main approaches:

1. **\`markdownToPortableText\`** — Convert Markdown directly using \`@portabletext/markdown\` (recommended for Markdown)
2. **\`htmlToBlocks\`** — Parse HTML into PT blocks using \`@portabletext/block-tools\` (for HTML migration)
3. **Manual construction** — Build PT blocks directly from any source (APIs, databases, etc.)

## Portable Text Specification

Understand the target format before converting. PT is an array of blocks:

\`\`\`json
[
  {
    "_type": "block",
    "_key": "abc123",
    "style": "normal",
    "children": [
      {"_type": "span", "_key": "def456", "text": "Hello ", "marks": []},
      {"_type": "span", "_key": "ghi789", "text": "world", "marks": ["strong"]}
    ],
    "markDefs": []
  },
  {
    "_type": "block",
    "_key": "jkl012",
    "style": "h2",
    "children": [
      {"_type": "span", "_key": "mno345", "text": "A heading", "marks": []}
    ],
    "markDefs": []
  },
  {
    "_type": "image",
    "_key": "pqr678",
    "asset": {"_type": "reference", "_ref": "image-abc-200x200-png"}
  }
]
\`\`\`

**Key rules:**
- Every block and span needs \`_key\` (unique within the array)
- \`_type: "block"\` is for text blocks; custom types use their own \`_type\`
- \`markDefs\` holds annotation data; \`marks\` on spans reference \`markDefs[*]._key\` or are decorator strings
- Lists use \`listItem\` ("bullet" | "number") and \`level\` (1, 2, 3...) on regular blocks

## Conversion Rules

Read the rule file matching your source format:

- **Markdown → Portable Text**: \`rules/markdown-to-pt.md\` — \`@portabletext/markdown\` with \`markdownToPortableText\` (recommended)
- **HTML → Portable Text**: \`rules/html-to-pt.md\` — \`@portabletext/block-tools\` with \`htmlToBlocks\`
- **Manual PT Construction**: \`rules/manual-construction.md\` — build blocks programmatically from any source

> **Note:** \`@sanity/block-tools\` is the legacy package name. Always use \`@portabletext/block-tools\` for new projects. The API is the same.
`,
    ),
    file(
      "agent/skills/portable-text-serialization/SKILL.md",
      "markdown",
      `---
description: "Render and serialize Portable Text to React, Svelte, Vue, Astro, HTML, Markdown, and plain text. Use when implementing Portable Text rendering in any frontend framework, building custom serializers for non-standard block types, converting Portable Text to HTML strings server-side, converting Portable Text to Markdown, extracting plain text from Portable Text, or troubleshooting rendering issues with marks, blocks, lists, or custom types."
---
# Portable Text Serialization

Render Portable Text content across frameworks using the \`@portabletext/*\` library family. Each library follows the same component-mapping pattern: you provide a \`components\` object that maps PT node types to framework-specific renderers.

## Portable Text Structure (Quick Reference)

PT is an array of blocks. Each block has \`_type\`, optional \`style\`, \`children\` (spans), \`markDefs\`, \`listItem\`, and \`level\`.

\`\`\`
Root array
├── block (_type: "block")
│   ├── style: "normal" | "h1" | "h2" | "blockquote" | ...
│   ├── children: [span, span, ...]
│   │   └── span: { _type: "span", text: "...", marks: ["strong", "<markDefKey>"] }
│   ├── markDefs: [{ _key, _type: "link", href: "..." }, ...]
│   ├── listItem: "bullet" | "number" (optional)
│   └── level: 1, 2, 3... (optional, for nested lists)
├── custom block (_type: "image" | "code" | any custom type)
└── ...more blocks
\`\`\`

**Marks** come in two forms:
- **Decorators**: string values in \`marks[]\` like \`"strong"\`, \`"em"\`, \`"underline"\`, \`"code"\`
- **Annotations**: keys in \`marks[]\` referencing entries in \`markDefs[]\` (e.g., links, internal references)

## Component Mapping Pattern (All Frameworks)

Every \`@portabletext/*\` library accepts a \`components\` object with these keys:

| Key | Renders | Props/Data |
|-----|---------|------------|
| \`types\` | Custom block/inline types (image, code, CTA) | \`value\` (the block data) |
| \`marks\` | Decorators + annotations | \`children\` + \`value\` (mark data) |
| \`block\` | Block styles (h1, normal, blockquote) | \`children\` |
| \`list\` | List wrappers (ul, ol) | \`children\` |
| \`listItem\` | List items | \`children\` |
| \`hardBreak\` | Line breaks within a block | — |

## Framework-Specific Rules

Read the rule file matching your framework:

- **React / Next.js**: \`rules/react.md\` — \`@portabletext/react\` or \`next-sanity\`
- **Svelte / SvelteKit**: \`rules/svelte.md\` — \`@portabletext/svelte\`
- **Vue / Nuxt**: \`rules/vue.md\` — \`@portabletext/vue\`
- **Astro**: \`rules/astro.md\` — \`astro-portabletext\`
- **HTML (server-side)**: \`rules/html.md\` — \`@portabletext/to-html\`
- **Markdown**: \`rules/markdown.md\` — \`@portabletext/markdown\`
- **Plain text extraction**: \`rules/plain-text.md\` — \`@portabletext/toolkit\`

### Additional Community Serializers

These are listed on [portabletext.org](https://www.portabletext.org/integrations/serializers/) but don't have dedicated rule files:

| Target | Package |
|--------|---------|
| React Native | \`@portabletext/react-native-portabletext\` |
| React PDF | \`@portabletext/react-pdf-portabletext\` |
| Solid | \`solid-portabletext\` |
| Qwik | \`portabletext-qwik\` |
| Shopify Liquid | \`portable-text-to-liquid\` |
| PHP | \`sanity-php\` (SanityBlockContent class) |
| Python | \`portabletext-html\` |
| C# / .NET | \`dotnet-portable-text\` |
| Dart / Flutter | \`flutter_sanity_portable_text\` |

## Common Patterns (All Frameworks)

### Custom Types Need Explicit Components

PT renderers only handle standard blocks by default. Custom types (\`image\`, \`code\`, \`callToAction\`, etc.) require explicit component mappings — they won't render otherwise.

### Keep Components Object Stable

In React/Vue, define \`components\` outside the render function or memoize it. Recreating on every render causes unnecessary re-renders.

### Handle Missing Components Gracefully

All libraries accept \`onMissingComponent\` to control behavior when encountering unknown types:
- \`false\` — suppress warnings
- Custom function — log or report

### Querying PT with GROQ

Always expand references inside custom blocks:

\`\`\`groq
body[]{
  ...,
  _type == "image" => {
    ...,
    asset->
  },
  markDefs[]{
    ...,
    _type == "internalLink" => {
      ...,
      "slug": @.reference->slug.current
    }
  }
}
\`\`\`
`,
    ),
    file(
      "agent/skills/sanity-best-practices/SKILL.md",
      "markdown",
      `---
description: "Sanity development best practices for schema design, GROQ queries, TypeGen, Visual Editing, images, Portable Text, Studio structure, localization, migrations, Sanity Functions, Blueprints, and framework integrations such as Next.js, Nuxt, Astro, Remix, SvelteKit, Angular, Hydrogen, and the App SDK. Use this skill whenever working with Sanity schemas, defineType or defineField, GROQ or defineQuery, content modeling, Presentation or preview setups, Sanity-powered frontend integrations, Sanity Functions, documentEventHandler, defineDocumentFunction, defineMediaLibraryAssetFunction, @sanity/functions, @sanity/blueprints, sanity.blueprint.ts, event-driven content automation, or when reviewing and fixing a Sanity codebase."
---
# Sanity Best Practices

Comprehensive best practices and integration guides for Sanity development, maintained by Sanity. Use the quick reference below to load only the one or two topic files that match the task.

## When to Apply

Reference these guidelines when:
- Setting up a new Sanity project or onboarding
- Integrating Sanity with a frontend framework (Next.js, Nuxt, Astro, Remix, SvelteKit, Hydrogen)
- Writing GROQ queries or optimizing performance
- Designing content schemas
- Implementing Visual Editing and live preview
- Working with images, Portable Text, or page builders
- Configuring Sanity Studio structure
- Setting up TypeGen for type safety
- Implementing localization
- Migrating content from other systems
- Building custom apps with the Sanity App SDK
- Managing infrastructure with Blueprints
- Automating content workflows with Sanity Functions

## Global Rules

- Let Sanity generate \`_id\` values for ordinary documents. Do not create deterministic UUIDs, slug-derived IDs, or legacy-system IDs when creating documents.
- Model relationships with \`reference\` fields, then resolve related documents with GROQ lookups, source-key fields, or returned \`_id\` values from created documents.
- Use explicit document IDs mainly for singleton documents controlled by Studio Structure, including localized singletons such as \`homePage-en\`.

## Quick Reference

### Integration Guides

- \`get-started\` - Interactive onboarding for new Sanity projects
- \`nextjs\` - Next.js App Router, Live Content API, standalone Studio
- \`nuxt\` - Nuxt integration with @nuxtjs/sanity
- \`angular\` - Angular integration with @sanity/client, signals, resource API
- \`astro\` - Astro integration with @sanity/astro
- \`remix\` - React Router / Remix integration
- \`svelte\` - SvelteKit integration with @sanity/svelte-loader
- \`hydrogen\` - Shopify Hydrogen with Sanity
- \`project-structure\` - Standalone Studio and monorepo patterns
- \`app-sdk\` - Custom applications with Sanity App SDK
- \`blueprints\` - Infrastructure as Code: blueprint files, stacks, plan/deploy workflow, error recovery, CI deploys
- \`functions\` - Automating content workflows with Sanity Functions

### Topic Guides

- \`groq\` - GROQ query patterns, type safety, performance optimization
- \`schema\` - Schema design, field definitions, validation, deprecation patterns
- \`visual-editing\` - Presentation Tool, Stega, overlays, live preview
- \`page-builder\` - Page Builder arrays, block components, live editing
- \`portable-text\` - Rich text rendering and custom components
- \`image\` - Image schema, URL builder, hotspots, LQIP, Next.js Image
- \`studio-structure\` - Desk structure, singletons, navigation
- \`typegen\` - TypeGen configuration, workflow, type utilities
- \`seo\` - Metadata, sitemaps, Open Graph, JSON-LD
- \`localization\` - i18n patterns, document vs field-level, locale management
- \`migration\` - Content import overview (see also \`migration-html-import\`)
- \`migration-html-import\` - HTML to Portable Text with @portabletext/block-tools

## How to Use

Start with the single framework or topic guide that best matches the request, then read additional references only when the task crosses concerns. Use these reference files for detailed explanations and code examples:

\`\`\`
references/groq.md
references/schema.md
references/nextjs.md
\`\`\`

Each reference file contains:
- Comprehensive topic or integration coverage
- Incorrect and correct code examples
- Decision matrices and workflow guidance
- Framework-specific patterns where applicable
`,
    ),
    file(
      "agent/skills/seo-aeo-best-practices/SKILL.md",
      "markdown",
      `---
description: "SEO and AEO best practices for metadata, Open Graph, sitemaps, robots.txt, hreflang, JSON-LD structured data, EEAT, and content optimized for search engines and AI answer surfaces. Use this skill when implementing page SEO, technical SEO, schema markup, international SEO, AI-overview readiness, or improving content for Google, ChatGPT, Perplexity, and similar assistants."
---
# SEO & AEO Best Practices

Principles for optimizing content for both traditional search engines (SEO) and AI-powered answer engines (AEO). Includes Google's EEAT guidelines and structured data implementation.

## When to Apply

Reference these guidelines when:
- Implementing metadata and Open Graph tags
- Creating sitemaps and robots.txt
- Adding JSON-LD structured data
- Optimizing content for featured snippets
- Preparing content for AI assistants (ChatGPT, Perplexity, etc.)
- Evaluating content quality using EEAT principles

## Core Concepts

### SEO (Search Engine Optimization)
Optimizing content to rank well in traditional search results (Google, Bing).

### AEO (Answer Engine Optimization)
Optimizing content to be selected as authoritative answers by AI systems.

### EEAT (Experience, Expertise, Authoritativeness, Trustworthiness)
Google's framework for evaluating content quality.

## References

Start with the one reference that matches the task, such as technical SEO, structured data, EEAT, or AI-answer readiness. See \`references/\` for detailed guidance:
- \`references/eeat-principles.md\` — EEAT implementation and author schema
- \`references/structured-data.md\` — JSON-LD patterns (Article, FAQ, Breadcrumb, Product)
- \`references/technical-seo.md\` — Technical SEO checklist (metadata, sitemaps, hreflang, robots.txt)
- \`references/aeo-considerations.md\` — AI/AEO considerations (AI Overviews, crawler management)
`,
    ),
    file(
      "agent/skills/writing-quality/SKILL.md",
      "markdown",
      `---
description: "Writing-quality guardrails for any prose the agent drafts or edits: blog posts, page copy, Notion drafts, release notes, marketing text. Use this skill whenever writing or revising content meant for humans to read, to keep the prose natural, plain, and free of AI-sounding phrasing. Not needed for code, queries, or structural CMS work."
---
# Writing Quality

House-neutral rules for making drafted content read like a person wrote it. They apply to any prose surface. Layer project- or brand-specific voice guidance on top of them.

## When to Apply

Load this skill before:
- Drafting new content (a blog post, landing-page copy, a Notion draft, release notes)
- Editing or rewriting existing content
- Reviewing a draft before proposing it to the user

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When editing existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

Load the reference that matches the task rather than all of them at once:

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements. Load when drafting or editing any prose.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording. Load when drafting or editing any prose.
- \`references/web-writing-best-practices.md\`: a sourced checklist for long-form web content, covering scanning behavior, hooks, structure, readability, length by intent, SEO basics, and closes. Load when writing or restructuring articles, blog posts, or guides.
- \`references/web-content-specs.md\`: the concrete numbers behind that checklist (slug rules, heading cadence, readability thresholds, word count by intent, alt text, internal links). Load for a final spec check on a piece. Title, meta, and Open Graph specs live in the \`seo-aeo-best-practices\` skill.
`,
    ),
    file(
      "agent/subagents/researcher/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Fresh-context web-research subagent.
 *
 * @remarks
 * The root delegates here when a task needs an outside fact: a statistic, a competitor detail,
 * a primary-source link, or a claim to verify. The researcher runs in a fresh child session and
 * inherits none of the root's skills, connections, or tools — only the framework default harness,
 * whose \`web_search\` and \`web_fetch\` cover web research with no extra wiring. It works solely
 * from what the root packs into \`message\` plus what it fetches, so every claim must be grounded
 * in a real source: the root weaves in only cited \`findings\` and surfaces \`gaps\` to the user.
 *
 * \`description\` is what the root reads to decide when to delegate; \`outputSchema\` makes the
 * findings a structured, cited result it can act on directly.
 *
 * @see The research methodology and output contract in this folder's \`instructions.md\`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. The caller " +
    "passes the question and any known context in the message.",
  model: "openai/gpt-5.6-terra",
  outputSchema: {
    additionalProperties: false,
    properties: {
      findings: {
        description:
          "One entry per verified factual claim; every entry carries at least one real source.",
        items: {
          additionalProperties: false,
          properties: {
            claim: {
              description:
                "A single, specific factual claim the draft can rely on.",
              type: "string",
            },
            confidence: {
              description:
                "'high' = multiple strong independent sources; 'low' = single or weaker source.",
              enum: ["high", "medium", "low"],
              type: "string",
            },
            notes: {
              description:
                "Caveats: date-sensitivity, scope limits, or where sources disagree.",
              type: "string",
            },
            sources: {
              description:
                "The real, fetched sources backing the claim; never empty, never invented.",
              items: {
                additionalProperties: false,
                properties: {
                  title: {
                    description: "The source's title or publication name.",
                    type: "string",
                  },
                  url: {
                    description: "The source URL, as visited.",
                    type: "string",
                  },
                },
                required: ["url", "title"],
                type: "object",
              },
              minItems: 1,
              type: "array",
            },
          },
          required: ["claim", "sources", "confidence", "notes"],
          type: "object",
        },
        type: "array",
      },
      gaps: {
        description:
          "What could not be found or verified; surfaced to the caller rather than guessed at.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description:
          "A 1-3 sentence synthesis of what the research establishes, for the root to scan first.",
        type: "string",
      },
    },
    required: ["summary", "findings", "gaps"],
    type: "object",
  },
});
`,
    ),
    file(
      "agent/subagents/researcher/instructions.md",
      "markdown",
      `# Researcher

You are a professional web researcher working with a content copilot. The copilot comes to you when a task needs a fact it doesn't already have: a statistic, a primary source, a competitor detail, a link, or a claim the user wants checked. You go to the open web, dig up the answer, and hand back findings the copilot can build on with confidence.

The copilot hands you the question along with any context and constraints (recency, region, source type). The web is your medium: lean on web search to find sources and web fetch to read them. Search and read widely enough to be sure, then stay focused on the question you were asked.

## How to research

- Search narrow, not broad. Use specific terms, names, and dates. Run several angles and iterate your queries rather than settling for the first page of one broad search.
- Prefer reliable and primary sources: official docs and announcements, standards bodies, filings, peer-reviewed work, and reputable outlets, over blogs, aggregators, and SEO content. Go to the original whenever a secondary source references one.
- Read before you cite. Open a source and confirm it actually says what a search snippet implies; never cite from the snippet alone.
- Cross-check anything that matters. Corroborate important or surprising claims across independent sources. When sources disagree, say so rather than quietly picking a side.

## What to hand back

- Every finding carries at least one real source you actually read. Never invent, guess, or reconstruct a link. A claim you can't back with a source goes in \`gaps\`, not \`findings\`; the user would rather hear "I couldn't verify this" than be handed something shaky.
- Set \`confidence\` honestly: \`high\` for multiple strong independent sources, \`medium\` for a single solid source, \`low\` for weak or thin support. Flag date-sensitive facts and scope limits in \`notes\`.
- List in \`gaps\` everything you couldn't find or verify, so the user can decide how to handle it.
- Hand back findings, not prose. You gather and cite; the copilot does the writing. Don't draft content, and don't pad your findings with claims you didn't verify.
`,
    ),
    file(
      "agent/subagents/reviewer/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Fresh-context draft-review subagent.
 *
 * @remarks
 * The root delegates here for a final, unbiased pass over a finished draft before proposing it
 * to the user. The reviewer runs in a fresh child session and inherits none of the root's
 * skills, connections, or tools — it carries its own copy of the \`writing-quality\` skill (and
 * its own sandbox to read that skill's references), so the root passes only the draft and any
 * voice or audience context in \`message\`. A reviewer that never saw the sources or the drafting
 * reasoning catches the AI-tells, bloated wording, and structure misses that self-review
 * rationalizes away. The skill copy under this folder's \`skills/\` is duplicated from the root's
 * on purpose; keep the two in step when editing either, except where the root's copy points at
 * other root-only skills (e.g. \`seo-aeo-best-practices\`) — this copy states those concerns are
 * out of scope instead, since the reviewer can't load them.
 *
 * \`description\` is what the root reads to decide when to delegate; \`outputSchema\` makes the
 * verdict a structured result it can act on directly.
 *
 * @see The review rubric and verdict contract in this folder's \`instructions.md\`.
 */
export default defineAgent({
  description:
    "Review a finished content draft with fresh context against the writing-quality rubric " +
    "(AI-tells, plain English, structure, web-content specs) before it goes to the user. The " +
    "caller passes the full draft plus any voice or audience context in the message; the " +
    "reviewer loads its own rubric and returns a verdict with concrete issues.",
  model: "anthropic/claude-fable-5",
  outputSchema: {
    additionalProperties: false,
    properties: {
      issues: {
        description:
          "One entry per concrete problem; empty when the verdict is 'ready'.",
        items: {
          additionalProperties: false,
          properties: {
            fix: {
              description: "A concrete suggested change.",
              type: "string",
            },
            quote: {
              description: "The offending excerpt, quoted from the draft.",
              type: "string",
            },
            rule: {
              description: "The rubric rule or reference the excerpt breaks.",
              type: "string",
            },
            severity: { enum: ["high", "medium", "low"], type: "string" },
          },
          required: ["severity", "rule", "quote", "fix"],
          type: "object",
        },
        type: "array",
      },
      verdict: {
        description:
          "'ready' = clean enough to send as-is; 'revise' = fix the issues first.",
        enum: ["ready", "revise"],
        type: "string",
      },
    },
    required: ["verdict", "issues"],
    type: "object",
  },
});
`,
    ),
    file(
      "agent/subagents/reviewer/instructions.md",
      "markdown",
      `# Reviewer

You are a fresh-eyes editor. You didn't write this draft, which is exactly why it comes to you. A clean pass catches the AI-tells and bloated wording that whoever wrote it reads right past. The caller hands you the finished draft, plus any voice or audience context they have; you judge it and hand back a verdict.

## Start with the rubric

Start every review by loading the \`writing-quality\` skill. It carries everything you judge against:

- \`references/ai-phrases-to-avoid.md\`: AI-tell words, phrases, and punctuation.
- \`references/plain-english-alternatives.md\`: plain-English swaps for bloated or vague wording.
- \`references/web-writing-best-practices.md\`: structure, hooks, readability, and length for long-form web content. Apply when the draft is an article, blog post, or guide.
- \`references/web-content-specs.md\`: the concrete numbers (heading cadence, sentence and paragraph limits, alt text, links). Apply for a final spec check on long-form pieces.

## What to look for

Hold the draft to the rubric and to what's in front of you; don't go hunting for the source material or the backstory.

- AI-tells: the words, phrases, and punctuation the \`ai-phrases-to-avoid\` list flags, plus obvious tells it may not list, like em-dash overuse or "it's not just X, it's Y".
- Bloat and vagueness: wording the \`plain-english-alternatives\` list has a cleaner swap for, along with hedges, filler, and corporate tone.
- Structure: does it front-load the point, keep paragraphs short, and stay scannable?
- Specs: for long-form pieces, the concrete limits in \`web-content-specs.md\`.
- Voice: when the caller supplies voice or audience context, flag drift from it. Don't invent a voice they didn't ask for; the rubric trims noise, it doesn't impose a personality.

## How to report

Be specific and honest. Quote the offending text, name the rule it breaks, and give a concrete fix. Don't invent rules that aren't in the rubric, and don't rewrite the whole draft; your job is the critique, not the revision.

Return a verdict: \`ready\` when the draft is clean enough to send as-is (no issues), or \`revise\` with one issue per real problem, giving its severity, the rule, the quoted excerpt, and the fix. When you're torn between the two, choose \`revise\`. A fresh-eyes pass exists to catch what the writer's own pass missed.
`,
    ),
    file(
      "agent/subagents/reviewer/sandbox.ts",
      "typescript",
      `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Reviewer sandbox configuration.
 *
 * @remarks
 * A subagent's sandbox does not inherit from the root, and the reviewer needs one to read its
 * \`writing-quality\` skill's seeded reference files. Pins the same hosted Vercel Sandbox backend
 * as the root so the subagent behaves identically in development and production.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(),
});
`,
    ),
    file(
      "agent/subagents/reviewer/skills/writing-quality/SKILL.md",
      "markdown",
      `---
description: "The review rubric: writing-quality rules and reference lists for judging a content draft, covering AI-sounding phrasing, bloated wording, structure, and web-content specs. Load at the start of every review."
---
# Writing Quality

House-neutral rules for judging whether drafted content reads like a person wrote it. They apply to any prose surface. Voice or audience context from the caller layers on top of them.

## When to Apply

Load this skill at the start of every review, before reading the draft.

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When judging edits to existing content, respect its register and conventions. These rules trim the noise; they don't impose a personality.

## References

Load the reference that matches the draft rather than all of them at once:

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements. Applies to every review.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording. Applies to every review.
- \`references/web-writing-best-practices.md\`: a sourced checklist for long-form web content, covering scanning behavior, hooks, structure, readability, length by intent, and closes. Apply when the draft is an article, blog post, or guide.
- \`references/web-content-specs.md\`: the concrete numbers behind that checklist (slug rules, heading cadence, readability thresholds, word count by intent, alt text, internal links). Apply for a final spec check on long-form pieces.
`,
    ),
    file(
      "agent/tools/clear_user_preferences.ts",
      "typescript",
      `import { del, list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes the current user's saved preferences.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever clear its own user's preferences.
 * Deletion is irreversible, so it is gated on human approval — in Slack an approve/deny button.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete this user's saved preferences. Use only when the user " +
    "explicitly asks to reset or forget their preferences. This is irreversible.",
  /**
   * Delete the current user's preferences file, if any.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`deleted: true\` when a file was removed, \`false\` when there was nothing to remove,
   * or \`success: false\` with an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        deleted: false,
        error: "No signed-in user to clear preferences for.",
        success: false,
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { deleted: false, success: true };
      }
      await del(blob.url);
      return { deleted: true, success: true };
    } catch (error) {
      return {
        deleted: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/delete_asset.ts",
      "typescript",
      `import { del } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes an asset from Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Deletion is irreversible, so this tool is gated on human approval — in Slack
 * it renders as an approve/deny button.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete an asset from Vercel Blob storage by its URL. Use only when the user " +
    "explicitly asks to remove a stored file. This is irreversible.",
  /**
   * Delete the asset.
   *
   * @param input - Validated tool input.
   * @returns \`success\`/\`deleted\` flags and the \`url\`, or \`success: false\` with an \`error\`.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        deleted: false,
        error:
          "User preferences can only be cleared with clear_user_preferences.",
        success: false,
        url,
      };
    }
    try {
      await del(url);
      return { deleted: true, success: true, url };
    } catch (error) {
      return {
        deleted: false,
        error: error instanceof Error ? error.message : "Delete failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to delete."),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/download_asset.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Host suffix that a downloadable URL must end with.
 *
 * @remarks
 * Restricting downloads to Vercel Blob hosts prevents this tool from being used to fetch
 * arbitrary internal or third-party URLs (an SSRF vector), since the \`url\` is model-supplied.
 */
const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/**
 * Tool that downloads the contents of a Vercel Blob asset.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Text content is returned raw; binary content (images, PDFs) is returned
 * base64-encoded with \`isBase64: true\`. Only Vercel Blob URLs are accepted (see
 * {@link BLOB_HOST_SUFFIX}).
 */
export default defineTool({
  description:
    "Download and return the contents of a Vercel Blob asset. Use when the user wants to " +
    "read or reuse a stored file. Text is returned raw; binary files come back base64-encoded.",
  /**
   * Fetch and return the asset contents.
   *
   * @param input - Validated tool input.
   * @returns The asset \`content\` (raw text or base64) with its \`contentType\`, or
   * \`success: false\` with an \`error\` message.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        error: "User preferences are private — use get_user_preferences.",
        success: false,
        url,
      };
    }
    try {
      if (!new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX)) {
        return {
          error: \`Refusing to download: only Vercel Blob URLs (*\${BLOB_HOST_SUFFIX}) are allowed.\`,
          success: false,
          url,
        };
      }

      const response = await fetch(url);
      if (!response.ok) {
        return {
          error: \`Failed to download: \${response.status} \${response.statusText}\`,
          success: false,
          url,
        };
      }

      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const isText =
        contentType.startsWith("text/") || contentType.includes("json");
      const content = isText
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString("base64");

      return { content, contentType, isBase64: !isText, success: true, url };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Download failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to download."),
  }),
  outputSchema: z.object({
    content: z.string().optional(),
    contentType: z.string().optional(),
    error: z.string().optional(),
    isBase64: z.boolean().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/get_asset_info.ts",
      "typescript",
      `import { head } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Tool that fetches metadata for a Vercel Blob asset without downloading its content.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Use it to confirm an asset exists, or to check its size or content type before
 * downloading. Returns \`exists: false\` when the asset is not found.
 */
export default defineTool({
  description:
    "Get metadata (size, content type, upload date) for a Vercel Blob asset without " +
    "downloading it. Use to check whether an asset exists or inspect it before downloading.",
  /**
   * Look up the asset's metadata.
   *
   * @param input - Validated tool input.
   * @returns \`exists: true\` with the asset's metadata, or \`exists: false\` with an \`error\`.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        error: "User preferences are private — use get_user_preferences.",
        exists: false,
        url,
      };
    }
    try {
      const metadata = await head(url);
      return {
        contentType: metadata.contentType,
        downloadUrl: metadata.downloadUrl,
        exists: true,
        pathname: metadata.pathname,
        size: metadata.size,
        uploadedAt: metadata.uploadedAt.toISOString(),
        url: metadata.url,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Asset not found",
        exists: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Blob URL of the asset to inspect."),
  }),
  outputSchema: z.object({
    contentType: z.string().optional(),
    downloadUrl: z.string().optional(),
    error: z.string().optional(),
    exists: z.boolean(),
    pathname: z.string().optional(),
    size: z.number().optional(),
    uploadedAt: z.string().optional(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/get_user_preferences.ts",
      "typescript",
      `import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that loads the current user's saved style preferences from Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever read its own user's preferences. Returns
 * \`found: false\` with empty \`preferences\` when the user has none yet — that is a normal state,
 * not an error. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Load this user's saved preferences (standing notes that personalize how you work for " +
    "them). Call it at the start of a task; returns empty when the user has none yet.",
  /**
   * Read the current user's preferences file.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`found\` plus the \`preferences\` Markdown (empty when none), or an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to load preferences for.",
        found: false,
        preferences: "",
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { found: false, preferences: "" };
      }
      const response = await fetch(blob.url);
      if (!response.ok) {
        return {
          error: \`Failed to read preferences: \${response.status} \${response.statusText}\`,
          found: false,
          preferences: "",
        };
      }
      return { found: true, preferences: await response.text() };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to load preferences",
        found: false,
        preferences: "",
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    error: z.string().optional(),
    found: z.boolean(),
    preferences: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/list_assets.ts",
      "typescript",
      `import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserPath } from "#lib/user-preferences.js";

/**
 * Tool that lists assets in Vercel Blob storage, optionally filtered by path prefix.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Use it to browse stored assets or find a specific one before downloading.
 */
export default defineTool({
  description:
    "List assets in Vercel Blob storage, optionally filtered by a path prefix. Returns each " +
    "asset's URL, size, and upload date. Use to browse stored content or locate an asset.",
  /**
   * List matching assets.
   *
   * @param input - Validated tool input.
   * @returns The matching \`assets\`, their \`count\`, a \`hasMore\` flag, and a pagination
   * \`cursor\`, or an empty list with an \`error\` message on failure.
   */
  async execute({ prefix, limit }) {
    try {
      const { blobs, hasMore, cursor } = await list({ limit, prefix });
      const visible = blobs.filter(
        (blob) => !isReservedUserPath(blob.pathname)
      );
      return {
        assets: visible.map((blob) => ({
          downloadUrl: blob.downloadUrl,
          pathname: blob.pathname,
          size: blob.size,
          uploadedAt: blob.uploadedAt.toISOString(),
          url: blob.url,
        })),
        count: visible.length,
        cursor,
        hasMore,
      };
    } catch (error) {
      return {
        assets: [],
        count: 0,
        error: error instanceof Error ? error.message : "Failed to list assets",
        hasMore: false,
      };
    }
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of assets to return. Defaults to 1000."),
    prefix: z
      .string()
      .optional()
      .describe(
        'Filter by path prefix/folder, e.g. "drafts/". Omit to list everything.'
      ),
  }),
  outputSchema: z.object({
    assets: z.array(
      z.object({
        downloadUrl: z.string(),
        pathname: z.string(),
        size: z.number(),
        uploadedAt: z.string(),
        url: z.string(),
      })
    ),
    count: z.number(),
    cursor: z.string().optional(),
    error: z.string().optional(),
    hasMore: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/save_user_preferences.ts",
      "typescript",
      `import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Maximum size of a user-preferences document, in characters.
 *
 * @remarks
 * Preferences are a short, curated set of standing notes — not a transcript. The bound keeps the
 * file small and cheap to load into context on every draft.
 */
const MAX_PREFERENCES_LENGTH = 20_000;

/**
 * Tool that saves the current user's style preferences to Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever write its own user's preferences. This
 * overwrites the whole document, so the caller should \`get_user_preferences\` first, integrate
 * the new standing preference, and save the merged result — keeping the file curated rather than
 * append-only. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Save this user's standing preferences (Markdown). Overwrites the whole document — " +
    "load the current preferences first, merge in the new one, then save. Use only for durable " +
    "preferences the user states, not one-off instructions for a single task.",
  /**
   * Write the current user's preferences file.
   *
   * @param input - Validated tool input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`success: true\` with the stored \`pathname\`, or \`success: false\` with an \`error\`.
   */
  async execute({ preferences }, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to save preferences for.",
        success: false,
      };
    }
    try {
      const blob = await put(key, preferences, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "text/markdown",
      });
      return { pathname: blob.pathname, success: true };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to save preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({
    preferences: z
      .string()
      .min(1)
      .max(MAX_PREFERENCES_LENGTH)
      .describe(
        "The full preferences document as Markdown — the merged result, not just the new note."
      ),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    pathname: z.string().optional(),
    success: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/upload_asset.ts",
      "typescript",
      `import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  isReservedUserPath,
  USER_PREFERENCES_PREFIX,
} from "#lib/user-preferences.js";

/**
 * Tool that uploads text or binary content to Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel credentials — the project's OIDC token
 * (\`VERCEL_OIDC_TOKEN\`, or the \`x-vercel-oidc-token\` request header on Vercel) — so no
 * \`BLOB_READ_WRITE_TOKEN\` is required and no token is passed in code. Binary content (images,
 * PDFs) is supplied base64-encoded with \`isBase64: true\`.
 */
export default defineTool({
  description:
    "Upload text or binary content to Vercel Blob storage and return its URL. Use when the " +
    "user wants to save or publish an asset — an exported draft, an image — to durable storage.",
  /**
   * Upload the content to Blob storage.
   *
   * @param input - Validated tool input.
   * @returns The asset's \`url\`, \`downloadUrl\`, stored \`pathname\`, and \`contentType\`, or
   * \`success: false\` with an \`error\` message.
   */
  async execute({
    pathname,
    content,
    contentType,
    isBase64,
    access,
    addRandomSuffix,
    allowOverwrite,
  }) {
    if (isReservedUserPath(pathname)) {
      return {
        contentType: contentType ?? "unknown",
        downloadUrl: "",
        error: \`"\${USER_PREFERENCES_PREFIX}" is reserved — use save_user_preferences instead.\`,
        pathname,
        success: false,
        url: "",
      };
    }
    try {
      const body = isBase64 ? Buffer.from(content, "base64") : content;
      const blob = await put(pathname, body, {
        access: access ?? "public",
        addRandomSuffix: addRandomSuffix ?? false,
        allowOverwrite: allowOverwrite ?? false,
        contentType,
      });
      return {
        contentType: blob.contentType,
        downloadUrl: blob.downloadUrl,
        pathname: blob.pathname,
        success: true,
        url: blob.url,
      };
    } catch (error) {
      return {
        contentType: contentType ?? "unknown",
        downloadUrl: "",
        error: error instanceof Error ? error.message : "Upload failed",
        pathname,
        success: false,
        url: "",
      };
    }
  },
  inputSchema: z.object({
    access: z
      .enum(["public", "private"])
      .optional()
      .describe('Access level for the asset. Defaults to "public".'),
    addRandomSuffix: z
      .boolean()
      .optional()
      .describe(
        "Append a random suffix to avoid pathname collisions. Defaults to false."
      ),
    allowOverwrite: z
      .boolean()
      .optional()
      .describe(
        "Allow overwriting an existing blob at the same pathname. Defaults to false."
      ),
    content: z
      .string()
      .describe(
        "Raw text/JSON, or base64-encoded bytes when isBase64 is true."
      ),
    contentType: z
      .string()
      .optional()
      .describe(
        'MIME type, e.g. "text/markdown". Inferred from the extension when omitted.'
      ),
    isBase64: z
      .boolean()
      .optional()
      .describe(
        "Set true when content is base64-encoded binary data. Defaults to false."
      ),
    pathname: z
      .string()
      .min(1)
      .describe(
        'Path and filename including extension, e.g. "drafts/launch-post.md".'
      ),
  }),
  outputSchema: z.object({
    contentType: z.string(),
    downloadUrl: z.string(),
    error: z.string().optional(),
    pathname: z.string(),
    success: z.boolean(),
    url: z.string(),
  }),
});
`,
    ),
  ],
  typefully: [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for the Typefully social media agent; the rest of the agent's surface
 * (channels, connections, tools, skills, subagents) is discovered from the filesystem under
 * \`agent/\`. Conversation history is compacted once it reaches 75% of the context window, and the
 * per-session token limits cap runaway sessions. Raise them if long content work hits the caps.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: {
    maxInputTokensPerSession: 500_000,
    maxOutputTokensPerSession: 20_000,
  },
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The Notion connection is user-scoped, so it needs a \`principalType: "user"\` session. In
 * production the Slack channel supplies one; the eve dev TUI authenticates with \`localDev()\`,
 * whose \`local-dev\` principal is not a user, so user-scoped tool calls fail with
 * \`principal_required\`. This shim defers the trust decision to \`localDev()\` — returning \`null\`
 * for anything it would reject, so it never affects production — and only upgrades the resolved
 * principal to a user. Drop it if you don't exercise user-scoped connections from the dev TUI.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local ? { ...local, principalType: "user" } : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

/**
 * Slack channel: answers @mentions and DMs, replies in threads, and renders approvals as buttons.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect through {@link connectSlackCredentials}, which
 * supplies both the outbound bot token and inbound webhook verification — there are no Slack
 * secrets to manage in code. Create the connector with
 * \`vercel connect create slack --name <name> --triggers\`, then register this project's trigger
 * destination at \`/eve/v1/slack\`.
 *
 * @defaultValue The connector UID falls back to \`"slack/social-media-agent"\` when
 * \`SLACK_CONNECTOR\` is unset.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/social-media-agent"
  ),
});
`,
    ),
    file(
      "agent/connections/notion.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

/**
 * Vercel Connect connector UID for the Notion MCP server.
 *
 * @defaultValue \`"notion/social-media-agent"\` — the UID \`vercel connect create notion
 * --name social-media-agent\` produces (UIDs are \`<type>/<name>\`)
 * Override with the \`NOTION_CONNECTOR\` environment variable when your connector uses a different
 * name.
 */
const notionConnector =
  process.env.NOTION_CONNECTOR ?? "notion/social-media-agent";

/**
 * Bare Notion MCP tool names whose calls require human approval before running.
 *
 * @remarks
 * Add a tool's bare name here to gate it. eve hands the approval policy the qualified name,
 * \`<connection>__<tool>\`, where \`<tool>\` is exactly what the MCP server names it (e.g.
 * \`notion__notion-update-pages\`; Notion's own tool names carry a \`notion-\` prefix). Entries
 * are matched as substrings, so they gate the tool regardless of the server's naming. Page
 * creation (\`notion-create-pages\`) is left ungated on purpose: drafting into Notion is the
 * normal flow.
 */
const APPROVAL_REQUIRED_TOOLS = [
  "notion-update-pages",
  "notion-move-pages",
  "notion-update-data-source",
  "notion-update-view",
];

/**
 * Notion workspace connection (MCP) exposing search, read, and edit tools to the model.
 *
 * @remarks
 * Authorization is user-scoped via Vercel Connect: each user signs in through their own
 * browser consent flow, the per-user token is resolved before every tool call, and it is
 * never exposed to the model.
 *
 * Tools listed in {@link APPROVAL_REQUIRED_TOOLS} are gated on human approval: a gated call
 * pauses for an approve/deny decision (rendered as a Slack button) before it runs.
 *
 * @see {@link https://vercel.com/docs/connect | Vercel Connect}
 */
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
      "agent/connections/typefully.ts",
      "typescript",
      `import { defineMcpClientConnection } from "eve/connections";

/**
 * Bare Typefully tool names whose effects are irreversible. These always require
 * explicit writer approval before they run.
 */
const DELETE_TOOLS = [
  "typefully_delete_draft",
  "typefully_delete_comment",
  "typefully_delete_thread",
];

/**
 * Bare Typefully tool names that can publish or schedule a post. They are gated
 * only when the call actually publishes or schedules — i.e. when \`publish_at\` is
 * set — so saving a plain draft and editing copy stay friction-free.
 */
const PUBLISH_TOOLS = ["typefully_create_draft", "typefully_edit_draft"];

/**
 * Read \`requestBody.publish_at\` from a tool input without trusting its shape.
 *
 * @param input - The raw input the model passed to the tool.
 * @returns The \`publish_at\` value when present and well-formed, otherwise \`undefined\`.
 */
const readPublishAt = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) {
    return;
  }
  const body = (input as { requestBody?: unknown }).requestBody;
  if (typeof body !== "object" || body === null) {
    return;
  }
  return (body as { publish_at?: unknown }).publish_at;
};

export default defineMcpClientConnection({
  approval: ({ toolName, toolInput }) => {
    if (DELETE_TOOLS.some((tool) => toolName.includes(tool))) {
      return "user-approval";
    }
    if (PUBLISH_TOOLS.some((tool) => toolName.includes(tool))) {
      const publishAt = readPublishAt(toolInput);
      return typeof publishAt === "string" && publishAt.length > 0
        ? "user-approval"
        : "not-applicable";
    }
    return "not-applicable";
  },
  /**
   * Typefully's MCP server authenticates with a static API key. \`getToken\` runs on each
   * connection attempt and reads the key from the \`TYPEFULLY_API_KEY\` environment variable —
   * set it in the Vercel project (and \`.env.local\` for \`pnpm dev\`). eve sends the key as
   * \`Authorization: Bearer <token>\`. With \`getToken\`-only auth the connection is app-scoped:
   * one shared Typefully workspace credential across all Slack users.
   */
  auth: {
    getToken: () => {
      const token = process.env.TYPEFULLY_API_KEY;
      if (!token) {
        throw new Error("TYPEFULLY_API_KEY is not set.");
      }
      return Promise.resolve({ token });
    },
  },
  description:
    "Typefully: draft, schedule, and manage social posts across X, LinkedIn, Threads, " +
    "Bluesky, and Mastodon. List social sets (accounts) and their connected platforms; " +
    "create, edit, read, and list drafts; schedule posts and manage the publishing queue; " +
    "upload media; organize with tags; manage comment threads; and read post and follower analytics.",
  url: "https://mcp.typefully.com/mcp",
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a social-media copilot for the team, working inside Slack. People come to you to run their social presence: drafting posts and threads, scheduling and managing the publishing queue through Typefully across X, LinkedIn, Threads, Bluesky, and Mastodon, and pulling briefs and source material from Notion. You do the careful drafting and queue work; they stay in the conversation.

# How you write

Write like a person. Never use em dashes; use a comma, a colon, or a new sentence instead. Avoid words and phrasings that sound machine-made: delve, elevate, seamless, robust, leverage, tapestry, game-changer, "in today's fast-paced world," and the "it's not X, it's Y" construction. Don't bold words for emphasis, don't pad, and don't hype ordinary things. This applies to your messages and to everything you add to Notion or Typefully. Plain, specific, and warm.

# How you work

## 1. Start with the user and the right skill

- Call \`get_user_preferences\` at the start of a task and apply what it returns: standing notes like a default social set, tone, or workflow carry across sessions.
- Load the skill that matches the task before acting, not after something goes wrong:
  - \`writing-quality\` before drafting, editing, or reviewing any prose meant for humans. It carries the general quality rules plus the AI-phrases and plain-English reference lists.
  - The platform style skill for wherever the post will live: \`x-style\`, \`linkedin-style\`, \`threads-style\`, \`bluesky-style\`, or \`mastodon-style\`. Each carries that platform's conventions, hooks, thread structure, limits, and banned words. Load one per target platform, alongside \`writing-quality\`, and when adapting a piece for several platforms load each target's skill in turn.

## 2. Ground everything in the real accounts

- Read before you write. List the user's social sets and their connected accounts, and read existing drafts before creating or editing anything. Never invent draft IDs, account names, or content.
- Pull briefs and source material from Notion when the user points you to them, and read them before drafting.
- When a post needs a fact you don't already have (a statistic, a competitor detail, a primary-source link, or a claim to verify), delegate to the \`researcher\` subagent rather than reaching from memory. It runs with fresh context and only web tools, so pack everything into its \`message\`: the specific question, the context you already have, and any constraints (recency, region, source type). Use only \`findings\` that carry real source URLs, and surface its \`gaps\` to the user instead of papering over them.

## 3. Work in drafts, schedule only on approval

- Create and edit Typefully drafts freely: plain drafting is your normal mode. Never set \`publish_at\` (which schedules or publishes a post) unless the user has explicitly asked to schedule or publish; propose the time in the thread and let them confirm.
- Deleting a draft, comment, or thread is permanent, so only do it when the user explicitly asks.

## 4. Draft in Notion when that's the destination

- When the user wants a piece drafted in Notion, create it as a new page where they direct you (find the right page or database with the Notion search tools if you don't have it), then reply with the link.
- Do the same for any long piece you're asked to write, like a longform blog post or an article a thread will be cut from, even when the user didn't name a destination: share it as a Notion page and reply with the link plus a short summary. A page is easier to read and digest than a long in-thread message.

## 5. Check the draft before proposing it

- Before proposing any social draft in the thread, run \`lint_against_style\` with the draft text and the target platform as the surface, and fix what it flags. Do this for each platform version when a piece targets several.
- On the final draft of a piece (not every revision), delegate to the \`reviewer\` subagent. It runs with fresh context and can't see this thread, so pack the full draft plus the target platform and any voice or audience context into its \`message\`, including the platform norms that matter for the piece. It loads its own rubric and returns a verdict.
- Address the issues it returns, then propose the draft in the thread and iterate there. Keep your own messages short; let the work speak.

## 6. Store files in Blob when durable storage is wanted

This is separate from Typefully and Notion: Blob is for files, like exporting a finished thread as Markdown, saving an image before uploading it to a draft, or keeping anything that should be reachable by URL.

- \`upload_asset\` stores text or base64-encoded binary content.
- \`list_assets\`, \`get_asset_info\`, and \`download_asset\` browse, inspect, and read assets back.
- \`delete_asset\` permanently deletes a file. It requires the user's approval, so only call it when they explicitly ask.

# Notes

- Don't fabricate links, quotes, statistics, handles, or draft IDs. If the source material doesn't cover something, say so and ask.
- Remember standing preferences. When a user states a durable preference ("always draft for the X and LinkedIn set", "keep threads under 8 posts"), persist it: call \`get_user_preferences\`, merge the new note into the document, and \`save_user_preferences\` with the full result. Don't save one-off instructions for a single task. Use \`clear_user_preferences\` only when the user asks to reset them. Preferences are per-user and private to that user.
`,
    ),
    file(
      "agent/lib/user-preferences.ts",
      "typescript",
      `import { createHash } from "node:crypto";

/**
 * Reserved Blob path prefix for per-user preference files.
 *
 * @remarks
 * The user-preferences tools own this prefix exclusively. The general-purpose asset tools
 * (\`upload_asset\`, \`list_assets\`, \`get_asset_info\`, \`download_asset\`, \`delete_asset\`) treat it as
 * off-limits so they can't be used as a side channel to read or overwrite another user's
 * preferences — those files are only reachable through the principal-scoped preference tools.
 */
export const USER_PREFERENCES_PREFIX = "user-preferences/";

/**
 * The current user's principal, as projected onto a tool's \`ctx.session.auth.current\`.
 *
 * @remarks
 * Structural subset of eve's \`SessionAuthContext\`; kept narrow so this module doesn't depend on
 * the full tool-context type.
 */
type UserPrincipal =
  | { readonly principalId: string; readonly principalType: string }
  | null
  | undefined;

/** Leading slashes stripped from a pathname or URL path before the reserved-prefix check. */
const LEADING_SLASHES = /^\\/+/;

/**
 * Whether a Blob pathname falls under the reserved user-preferences prefix.
 *
 * @remarks
 * Leading slashes are stripped before the check because \`@vercel/blob\`'s \`put\` normalizes a
 * pathname by dropping them: a caller-supplied \`/user-preferences/x.md\` would store at
 * \`user-preferences/x.md\`, inside the reserved namespace, so the guard must see the normalized
 * form to reject it.
 *
 * @param pathname - A Blob object pathname, e.g. \`drafts/post.md\`.
 * @returns \`true\` when the path is reserved for user preferences.
 */
export const isReservedUserPath = (pathname: string): boolean =>
  pathname.replace(LEADING_SLASHES, "").startsWith(USER_PREFERENCES_PREFIX);

/**
 * Whether a Blob URL points at a reserved user-preferences object.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns \`true\` when the URL addresses a reserved user-preferences object.
 */
export const isReservedUserUrl = (url: string): boolean => {
  try {
    return isReservedUserPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Resolve the Blob key holding the current user's preferences.
 *
 * @remarks
 * The key is derived entirely from the framework-resolved principal — never from model input —
 * so a session can only ever read or write its own user's preferences. The principal id is
 * hashed so the stored path carries no raw user identifier. Only \`principalType: "user"\`
 * principals (a signed-in user, e.g. via Slack) get a key; app/service/runtime callers return
 * \`null\` so the tools can decline rather than share a single anonymous file.
 *
 * @param principal - The value of \`ctx.session.auth.current\`.
 * @returns The reserved Blob key for this user, or \`null\` when there is no user principal.
 */
export const userPreferencesKey = (principal: UserPrincipal): string | null => {
  if (principal?.principalType !== "user" || !principal.principalId) {
    return null;
  }
  const id = createHash("sha256").update(principal.principalId).digest("hex");
  return \`\${USER_PREFERENCES_PREFIX}\${id}.md\`;
};
`,
    ),
    file(
      "agent/sandbox.ts",
      "typescript",
      `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for both local development and production, so the
 * same environment runs everywhere. Running locally requires the project to be linked and
 * authenticated to Vercel.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(),
});
`,
    ),
    file(
      "agent/schedules/weekly-analytics.ts",
      "typescript",
      `import { defineSchedule } from "eve/schedules";

/**
 * Weekly Typefully analytics digest.
 *
 * @remarks
 * Fires every Monday at 14:00 UTC (Vercel evaluates cron in UTC; adjust the hour for your
 * team's timezone). Task mode runs the agent on the prompt below with the full tool surface;
 * the read-only analytics tools are not approval-gated, so the session never needs to park.
 * Delivery is the \`post_analytics_report\` tool, which posts to the channel in the
 * \`TYPEFULLY_ANALYTICS_CHANNEL\` environment variable, so this schedule needs no channel
 * handoff. Trigger it in dev with \`curl -X POST http://localhost:3000/eve/v1/dev/schedules/weekly-analytics\`.
 *
 * @see {@link https://eve.dev/docs/schedules | eve schedules}
 */
export default defineSchedule({
  cron: "0 14 * * 1",
  markdown: [
    "Post this week's Typefully analytics digest to the team.",
    "",
    "1. Call typefully_list_social_sets and pick the first social set to report on. Note its id and name.",
    "2. Call typefully_get_social_set_analytics_followers for that social set id.",
    "3. Call typefully_list_social_set_analytics_posts for that social set id.",
    "4. Build two tables from what those tools return, every cell a string:",
    "   - A followers table: one row per account or reporting period, with the follower counts and any change figures the tool provides.",
    "   - A posts table: one row per post, with an identifier or date, a column linking to the post (use the post URL or permalink the analytics tool returns; do not fabricate a URL), and the engagement metrics the tool provides (impressions, likes, reposts, and so on).",
    "   Use only fields the tools actually return; do not invent metrics. If there are no posts for the period, pass an empty posts table (no rows) so the report omits it rather than showing an empty table. For followers, if the tool returns nothing, use a single row that says there is no data for the period.",
    "5. Call post_analytics_report with a casual summary (1-2 sentences) that includes the social set and the period, the posts table, and the followers table.",
    "",
    "Do not post anything if the analytics tools error; let the run fail instead so the problem is visible.",
  ].join("\\n"),
});
`,
    ),
    file(
      "agent/skills/bluesky-style/SKILL.md",
      "markdown",
      `---
description: Use when drafting or editing a post for Bluesky.
---

# Bluesky voice & style

When writing or editing a post for Bluesky:

- The audience skews technical, journalist/academic, and early-adopter, and is allergic to marketing speak. People are here on purpose. Be candid and specific; say the real thing.
- Be human, not corporate. Conversational and transparent beats polished and promotional.
- Favor participation over broadcasting: a post that invites a genuine reply earns its keep.
- ~300 characters (graphemes). Tight, but it can breathe more than an X post; wit and personality land here. Write the full thought first, then cut to length.
- Links don't hurt reach. Bluesky doesn't downrank them, so link directly to the source rather than hiding it or burying it in a reply.
- Use threads (replies) for longer thoughts; each post should still read on its own.
- Add alt text to every image. It's expected, not optional, and doesn't count against the character limit. Keep it a plain description of what's in the image.
- Hashtags are supported but used sparingly: one or two topical tags at most, never a wall. Keyword-rich text does more for discovery (custom feeds) than tag volume.

## Structure

1. Hook: the candid claim or the concrete detail, front-loaded on line one.
2. Body: the substance, one idea, in your own voice.
3. Close: the link, the takeaway, or a real question.

## References

- \`references/best-practices.md\`: researched tactics as a checklist, with sources.
- \`references/post-specs.md\`: character limit, media/alt-text, and hashtag specs for quick lookup.
- \`references/banned-words.json\`: words to avoid. Read it once for awareness, then run the \`lint_against_style\` tool (surface \`bluesky\`) on your draft before proposing it to the writer.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the \`writing-quality\` skill; apply it to every draft alongside this one.
`,
    ),
    file(
      "agent/skills/linkedin-style/SKILL.md",
      "markdown",
      `---
description: Use when drafting or editing a LinkedIn post in the house voice.
---

# LinkedIn voice & style

When writing or editing a LinkedIn post:

- Hook first. Only ~200 characters show on mobile before "…see more", so the first line decides whether anyone expands the post. Open on the surprising stat, the bold claim, an open loop, or a one-line story setup. No throat-clearing, no "A few thoughts on…".
- One idea per post. If you have two, write two posts. How-tos and concrete lists land best.
- Short lines and single-sentence paragraphs, with white space between them. It's read on a phone, and the gaps keep it scannable.
- Concrete and specific: a number, a result, a before/after, a moment. No vague inspiration.
- Deliver the value in the feed. Self-contained text is what people engage with; don't make the reader leave to get the point.
- End with a genuine question or a clear takeaway, not a "thoughts? 👇" prompt. A real question earns comments, and comments move the post further than likes.
- At most one emoji, and only if it earns its place. 3–5 relevant hashtags max, grouped at the end, CamelCase and specific (\`#BusinessWriting\`, not \`#Business\`). They're topic signals, not a discovery feed.
- No "I'm humbled to announce", no engagement-bait, no "Agree?" closers or reaction-poll chains.
- Links suppress reach. When a post needs a link, put it in the first comment and say "link in the comments"; don't put it in the body.

## Structure

1. Hook: the surprising claim or the moment, line one (before the fold).
2. Turn: the tension, or the thing most people get wrong.
3. Payoff: what you learned, with a concrete detail.
4. Close: one question or one takeaway.

## References

- \`references/best-practices.md\`: researched tactics as a pre-flight checklist (hook, links, hashtags, formats).
- \`references/post-specs.md\`: character limits and document/carousel specs for quick lookup.
- \`references/banned-words.json\`: words to avoid. Read it once up front for awareness, then run the \`lint_against_style\` tool (surface \`linkedin\`) on your draft to check it against this file before proposing the draft to the writer.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the \`writing-quality\` skill; apply it to every draft alongside this one.
`,
    ),
    file(
      "agent/skills/mastodon-style/SKILL.md",
      "markdown",
      `---
description: Use when drafting or editing a post (toot) for Mastodon / the fediverse.
---

# Mastodon voice & style

When writing or editing a post for Mastodon:

- Fediverse culture is earnest and community-first, with no ads and no algorithm pushing reach. Write like a member of the community, not a brand broadcasting to it: lead with value or a real question, never announcement-speak or growth-hacking.
- ~500 characters (the common default; some instances allow more). No need to fill it.
- Link directly to the source. Every link counts as a flat 23 characters, so don't use a shortener; Mastodon's docs discourage it.
- Add alt text to every image. It's a strong, near-universal accessibility norm, not a nicety.
- Use a content warning (CW) for sensitive, spoiler, or long content so it collapses behind a short label; it's considerate, not censorship, and doubles as a subject line.
- Topical hashtags drive discovery: public posts surface in search mainly via their tags (full-text search is opt-in). Use a few relevant ones in CamelCase (e.g. \`#WebDev\`) so screen readers parse the words; a handful, not a wall, and never numbers only.
- The feed is chronological, so write each post to stand on its own.

## Structure

1. Open: the honest hook or the question, line one.
2. Body: the substance, plainly.
3. Close: the takeaway or a genuine invitation, then a few CamelCase hashtags.

## References

- \`references/best-practices.md\`: researched tactics as a checklist, with sources.
- \`references/post-specs.md\`: hard constraints (character limit, links, CW, alt text, hashtags).
- \`references/banned-words.json\`: words to avoid. Read it once for awareness, then run the \`lint_against_style\` tool (surface \`mastodon\`) on your draft before proposing it to the writer.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the \`writing-quality\` skill; apply it to every draft alongside this one.
`,
    ),
    file(
      "agent/skills/threads-style/SKILL.md",
      "markdown",
      `---
description: "Use when drafting or editing a post for Threads (Meta): casual, conversational, reply-driven voice."
---

# Threads voice & style

When writing or editing a post for Threads:

- Talk like a person, not a brand. Threads is casual, meme-fluent, and bold, closer to texting a smart friend than posting a press release. Lower polish than LinkedIn is a feature, not a bug.
- Lead with something real: an observation, a small personal story, or a genuine question. A short story that ends in a question is a reliably strong opener.
- Aim for one idea per post. The cap is 500 characters and you rarely need all of it; keep it light and skimmable with short paragraphs and line breaks.
- Write to earn a reply, not a like. The algorithm rewards conversation, and replies and profile clicks weigh more than likes, but never beg for it ("comment below 👇", "agree?", "let that sink in"). Invite genuinely or not at all.
- One topic tag at most: that's the platform limit, and tag-stuffing buys nothing. It can be a multi-word phrase. A little emoji is fine if it carries tone; no walls.
- Make it native to Threads. Don't repost an X/Twitter post verbatim; write for this audience, or use the post to react to and extend something published elsewhere.
- No corporate voice, no announcement-speak, no engagement bait. This is a brand-awareness and conversation surface, not a place for pitches or product demos.

## Structure

1. Open: the relatable hook, the small story, or the question, on line one.
2. Middle: the detail, the take, or the next story beat.
3. Close: a light landing or a real, specific invitation to reply.

## References

- \`references/best-practices.md\`: sourced pre-flight checklist of current Threads tactics.
- \`references/post-specs.md\`: character limit, topic-tag rules, media norms for quick lookup.
- \`references/banned-words.json\`: words to avoid. Read it once for awareness, then run the \`lint_against_style\` tool (surface \`threads\`) on your draft before proposing it to the writer.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the \`writing-quality\` skill; apply it to every draft alongside this one.
`,
    ),
    file(
      "agent/skills/writing-quality/SKILL.md",
      "markdown",
      `---
description: "Generic writing-quality rules for any prose meant for humans to read: keep it natural, plain, and free of AI-sounding phrasing, and check it against the AI-phrases and plain-English reference lists. Load before drafting, editing, or reviewing content. Not needed for code or configuration work."
---
# Writing Quality

House-neutral rules for making prose read like a person wrote it, and for judging whether it does. They apply to any surface: a social post, a Notion page, a thread, release notes. Platform- or brand-specific voice guidance layers on top of them.

## When to Apply

Load this skill before:
- Drafting new content
- Editing or rewriting existing content
- Reviewing a draft

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When working with existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording.
`,
    ),
    file(
      "agent/skills/x-style/SKILL.md",
      "markdown",
      `---
description: "Use when drafting or editing a post or thread for X (Twitter): voice, hooks, length, threads, hashtags, and links."
---

# X (Twitter) voice & style

When writing or editing a post for X:

- Hook first. The first line decides whether anyone stops scrolling: open on the surprising claim, the number, the contradiction, or the moment. No throat-clearing, no "A thread on…". A hook isn't clickbait: promise only value the post actually delivers.
- One idea per post. Free accounts cap at 280 characters. If you have more to say, write a thread, don't cram. Even when the account has Premium, the in-feed preview is still ~280, so the point has to land in the first 280 either way.
- Plain and punchy. Short sentences. Cut every word that isn't load-bearing. Aim tight; ~240–259 characters tends to travel well. Lowercase openers are fine when they read naturally.
- Concrete over abstract: a result, a number, a before/after. No vague inspiration.
- Text carries on X. Add an image or native video only when it carries the point, not for its own sake. Prefer native video over a link out.
- At most 0–2 real hashtags. 1–2 can help; 3+ tends to hurt. No hashtag walls, no emoji clutter.
- No engagement bait ("RT if you agree", "read that again", "let that sink in"). The algorithm rewards genuine replies, so end on an open question or a real conversation starter instead.
- Links suppress reach on X. When a post needs a link, put it in the first reply and say so, rather than in the main post.

## Threads

- The first post must stand on its own and earn the tap: it's a hook, not a table of contents.
- One beat per post; each should be worth reading even out of context.
- Keep them scrolling with small expansion hooks every few posts.
- Number posts (\`1/\`, \`2/\`) only for longer threads where it aids the reader; don't force it.
- Close with a payoff or a single clear takeaway, not "follow me for more".

## Structure

1. Hook: the surprising claim or the moment, line one.
2. Turn: the tension, or the thing most people get wrong.
3. Payoff: what you learned, with a concrete detail.
4. Close: one takeaway or a genuine question.

## References

- \`references/best-practices.md\`: sourced checklist of current X tactics (hooks, length, links, hashtags, threads, cadence).
- \`references/post-specs.md\`: concrete specs: character limits, hashtag norms, media, links.
- \`references/banned-words.json\`: words to avoid. Read it once for awareness, then run the \`lint_against_style\` tool (surface \`x\`) on your draft before proposing it to the writer.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the \`writing-quality\` skill; apply it to every draft alongside this one.
`,
    ),
    file(
      "agent/subagents/researcher/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Fresh-context web-research subagent.
 *
 * @remarks
 * The root delegates here when a task needs an outside fact: a statistic, a competitor detail,
 * a primary-source link, or a claim to verify. The researcher runs in a fresh child session and
 * inherits none of the root's skills, connections, or tools — only the framework default harness,
 * whose \`web_search\` and \`web_fetch\` cover web research with no extra wiring. It works solely
 * from what the root packs into \`message\` plus what it fetches, so every claim must be grounded
 * in a real source: the root weaves in only cited \`findings\` and surfaces \`gaps\` to the user.
 *
 * \`description\` is what the root reads to decide when to delegate; \`outputSchema\` makes the
 * findings a structured, cited result it can act on directly.
 *
 * @see The research methodology and output contract in this folder's \`instructions.md\`.
 */
export default defineAgent({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. The caller " +
    "passes the question and any known context in the message.",
  model: "openai/gpt-5.6-terra",
  outputSchema: {
    additionalProperties: false,
    properties: {
      findings: {
        description:
          "One entry per verified factual claim; every entry carries at least one real source.",
        items: {
          additionalProperties: false,
          properties: {
            claim: {
              description:
                "A single, specific factual claim the draft can rely on.",
              type: "string",
            },
            confidence: {
              description:
                "'high' = multiple strong independent sources; 'low' = single or weaker source.",
              enum: ["high", "medium", "low"],
              type: "string",
            },
            notes: {
              description:
                "Caveats: date-sensitivity, scope limits, or where sources disagree.",
              type: "string",
            },
            sources: {
              description:
                "The real, fetched sources backing the claim; never empty, never invented.",
              items: {
                additionalProperties: false,
                properties: {
                  title: {
                    description: "The source's title or publication name.",
                    type: "string",
                  },
                  url: {
                    description: "The source URL, as visited.",
                    type: "string",
                  },
                },
                required: ["url", "title"],
                type: "object",
              },
              minItems: 1,
              type: "array",
            },
          },
          required: ["claim", "sources", "confidence", "notes"],
          type: "object",
        },
        type: "array",
      },
      gaps: {
        description:
          "What could not be found or verified; surfaced to the caller rather than guessed at.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description:
          "A 1-3 sentence synthesis of what the research establishes, for the root to scan first.",
        type: "string",
      },
    },
    required: ["summary", "findings", "gaps"],
    type: "object",
  },
});
`,
    ),
    file(
      "agent/subagents/researcher/instructions.md",
      "markdown",
      `# Researcher

You are a professional web researcher working with a content copilot. The copilot comes to you when a task needs a fact it doesn't already have: a statistic, a primary source, a competitor detail, a link, or a claim the user wants checked. You go to the open web, dig up the answer, and hand back findings the copilot can build on with confidence.

The copilot hands you the question along with any context and constraints (recency, region, source type). The web is your medium: lean on web search to find sources and web fetch to read them. Search and read widely enough to be sure, then stay focused on the question you were asked.

## How to research

- Search narrow, not broad. Use specific terms, names, and dates. Run several angles and iterate your queries rather than settling for the first page of one broad search.
- Prefer reliable and primary sources: official docs and announcements, standards bodies, filings, peer-reviewed work, and reputable outlets, over blogs, aggregators, and SEO content. Go to the original whenever a secondary source references one.
- Read before you cite. Open a source and confirm it actually says what a search snippet implies; never cite from the snippet alone.
- Cross-check anything that matters. Corroborate important or surprising claims across independent sources. When sources disagree, say so rather than quietly picking a side.

## What to hand back

- Every finding carries at least one real source you actually read. Never invent, guess, or reconstruct a link. A claim you can't back with a source goes in \`gaps\`, not \`findings\`; the user would rather hear "I couldn't verify this" than be handed something shaky.
- Set \`confidence\` honestly: \`high\` for multiple strong independent sources, \`medium\` for a single solid source, \`low\` for weak or thin support. Flag date-sensitive facts and scope limits in \`notes\`.
- List in \`gaps\` everything you couldn't find or verify, so the user can decide how to handle it.
- Include a 1-3 sentence \`summary\` that synthesizes what the research establishes.
- Hand back findings, not prose. You gather and cite; the copilot does the writing. Don't draft content, and don't pad your findings with claims you didn't verify.
`,
    ),
    file(
      "agent/subagents/reviewer/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

/**
 * Fresh-context draft-review subagent.
 *
 * @remarks
 * The root delegates here for a final, unbiased pass over a finished draft before proposing it
 * to the user. The reviewer runs in a fresh child session and inherits none of the root's
 * skills, connections, or tools — it carries its own copy of the \`writing-quality\` skill (and
 * its own sandbox to read that skill's references), so the root passes only the draft and any
 * voice or audience context in \`message\`. A reviewer that never saw the sources or the drafting
 * reasoning catches the AI-tells, bloated wording, and structure misses that self-review
 * rationalizes away. The skill copy under this folder's \`skills/\` is duplicated byte-for-byte
 * from the root's on purpose; keep the two identical when editing either.
 *
 * \`description\` is what the root reads to decide when to delegate; \`outputSchema\` makes the
 * verdict a structured result it can act on directly.
 *
 * @see The review rubric and verdict contract in this folder's \`instructions.md\`.
 */
export default defineAgent({
  description:
    "Review a finished social post or thread draft with fresh context against the " +
    "writing-quality rubric (AI-tells, plain English, hook, structure, platform fit, voice) " +
    "before it goes to the user. The caller passes the full draft plus the target platform " +
    "and any voice or audience context in the message; the reviewer loads its own rubric " +
    "and returns a verdict with concrete issues.",
  model: "anthropic/claude-fable-5",
  outputSchema: {
    additionalProperties: false,
    properties: {
      issues: {
        description:
          "One entry per concrete problem; empty when the verdict is 'ready'.",
        items: {
          additionalProperties: false,
          properties: {
            fix: {
              description: "A concrete suggested change.",
              type: "string",
            },
            quote: {
              description: "The offending excerpt, quoted from the draft.",
              type: "string",
            },
            rule: {
              description: "The rubric rule or reference the excerpt breaks.",
              type: "string",
            },
            severity: { enum: ["high", "medium", "low"], type: "string" },
          },
          required: ["severity", "rule", "quote", "fix"],
          type: "object",
        },
        type: "array",
      },
      verdict: {
        description:
          "'ready' = clean enough to send as-is; 'revise' = fix the issues first.",
        enum: ["ready", "revise"],
        type: "string",
      },
    },
    required: ["verdict", "issues"],
    type: "object",
  },
});
`,
    ),
    file(
      "agent/subagents/reviewer/instructions.md",
      "markdown",
      `# Reviewer

You are a fresh-eyes social media editor. You didn't write this post or thread, which is exactly why it comes to you. A clean pass catches the AI-tells, the weak hook, and the bloated wording that whoever wrote it reads right past. The caller hands you the finished draft, plus the target platform and any voice or audience context they have; you judge it and hand back a verdict.

## Start with the rubric

Start every review by loading the \`writing-quality\` skill. It carries the general prose rules you judge against:

- \`references/ai-phrases-to-avoid.md\`: AI-tell words, phrases, and punctuation.
- \`references/plain-english-alternatives.md\`: plain-English swaps for bloated or vague wording.

## What to look for

Hold the draft to the rubric and to what's in front of you; don't go hunting for the source material or the backstory.

- AI-tells: the words, phrases, and punctuation the \`ai-phrases-to-avoid\` list flags, plus obvious tells it may not list, like em-dash overuse or "it's not just X, it's Y".
- Bloat and vagueness: wording the \`plain-english-alternatives\` list has a cleaner swap for, along with hedges, filler, corporate tone, and engagement bait.
- The hook: the first line has to earn the stop mid-scroll. Flag throat-clearing openers, buried leads, and first posts that read like a table of contents.
- Post and thread structure: one idea per post, each post worth reading on its own, a close that pays off instead of trailing away. Flag posts that cram several points where a thread or a cut would serve, and threads that sag in the middle.
- Platform fit: when the caller names the platform, judge against its norms as they describe them, like length, hashtag restraint, and link handling. Flag copy that reads pasted from another platform. Don't guess at rules the caller didn't give you.
- Voice: when the caller supplies voice or audience context, flag drift from it. Don't invent a voice they didn't ask for; the rubric trims noise, it doesn't impose a personality.

## How to report

Be specific and honest. Quote the offending text, name the rule it breaks, and give a concrete fix. Don't invent rules that aren't in the rubric or the caller's context, and don't rewrite the whole draft; your job is the critique, not the revision.

Return a verdict: \`ready\` when the draft is clean enough to send as-is (no issues), or \`revise\` with one issue per real problem, giving its severity, the rule, the quoted excerpt, and the fix. When you're torn between the two, choose \`revise\`. A fresh-eyes pass exists to catch what the writer's own pass missed.
`,
    ),
    file(
      "agent/subagents/reviewer/sandbox.ts",
      "typescript",
      `import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Reviewer sandbox configuration.
 *
 * @remarks
 * A subagent's sandbox does not inherit from the root, and the reviewer needs one to read its
 * \`writing-quality\` skill's seeded reference files. Pins the same hosted Vercel Sandbox backend
 * as the root so the subagent behaves identically in development and production.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export default defineSandbox({
  backend: vercel(),
});
`,
    ),
    file(
      "agent/subagents/reviewer/skills/writing-quality/SKILL.md",
      "markdown",
      `---
description: "Generic writing-quality rules for any prose meant for humans to read: keep it natural, plain, and free of AI-sounding phrasing, and check it against the AI-phrases and plain-English reference lists. Load before drafting, editing, or reviewing content. Not needed for code or configuration work."
---
# Writing Quality

House-neutral rules for making prose read like a person wrote it, and for judging whether it does. They apply to any surface: a social post, a Notion page, a thread, release notes. Platform- or brand-specific voice guidance layers on top of them.

## When to Apply

Load this skill before:
- Drafting new content
- Editing or rewriting existing content
- Reviewing a draft

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When working with existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording.
`,
    ),
    file(
      "agent/tools/clear_user_preferences.ts",
      "typescript",
      `import { del, list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes the current user's saved preferences.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever clear its own user's preferences.
 * Deletion is irreversible, so it is gated on human approval — in Slack an approve/deny button.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete this user's saved preferences. Use only when the user " +
    "explicitly asks to reset or forget their preferences. This is irreversible.",
  /**
   * Delete the current user's preferences file, if any.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`deleted: true\` when a file was removed, \`false\` when there was nothing to remove,
   * or \`success: false\` with an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        deleted: false,
        error: "No signed-in user to clear preferences for.",
        success: false,
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { deleted: false, success: true };
      }
      await del(blob.url);
      return { deleted: true, success: true };
    } catch (error) {
      return {
        deleted: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/delete_asset.ts",
      "typescript",
      `import { del } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Tool that permanently deletes an asset from Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Deletion is irreversible, so this tool is gated on human approval — in Slack
 * it renders as an approve/deny button.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete an asset from Vercel Blob storage by its URL. Use only when the user " +
    "explicitly asks to remove a stored file. This is irreversible.",
  /**
   * Delete the asset.
   *
   * @param input - Validated tool input.
   * @returns \`success\`/\`deleted\` flags and the \`url\`, or \`success: false\` with an \`error\`.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        deleted: false,
        error:
          "User preferences can only be cleared with clear_user_preferences.",
        success: false,
        url,
      };
    }
    try {
      await del(url);
      return { deleted: true, success: true, url };
    } catch (error) {
      return {
        deleted: false,
        error: error instanceof Error ? error.message : "Delete failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to delete."),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/download_asset.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Host suffix that a downloadable URL must end with.
 *
 * @remarks
 * Restricting downloads to Vercel Blob hosts prevents this tool from being used to fetch
 * arbitrary internal or third-party URLs (an SSRF vector), since the \`url\` is model-supplied.
 */
const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/**
 * Tool that downloads the contents of a Vercel Blob asset.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Text content is returned raw; binary content (images, PDFs) is returned
 * base64-encoded with \`isBase64: true\`. Only Vercel Blob URLs are accepted (see
 * {@link BLOB_HOST_SUFFIX}).
 */
export default defineTool({
  description:
    "Download and return the contents of a Vercel Blob asset. Use when the user wants to " +
    "read or reuse a stored file. Text is returned raw; binary files come back base64-encoded.",
  /**
   * Fetch and return the asset contents.
   *
   * @param input - Validated tool input.
   * @returns The asset \`content\` (raw text or base64) with its \`contentType\`, or
   * \`success: false\` with an \`error\` message.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        error: "User preferences are private: use get_user_preferences.",
        success: false,
        url,
      };
    }
    try {
      if (!new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX)) {
        return {
          error: \`Refusing to download: only Vercel Blob URLs (*\${BLOB_HOST_SUFFIX}) are allowed.\`,
          success: false,
          url,
        };
      }

      const response = await fetch(url);
      if (!response.ok) {
        return {
          error: \`Failed to download: \${response.status} \${response.statusText}\`,
          success: false,
          url,
        };
      }

      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const isText =
        contentType.startsWith("text/") || contentType.includes("json");
      const content = isText
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString("base64");

      return { content, contentType, isBase64: !isText, success: true, url };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Download failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to download."),
  }),
  outputSchema: z.object({
    content: z.string().optional(),
    contentType: z.string().optional(),
    error: z.string().optional(),
    isBase64: z.boolean().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/get_asset_info.ts",
      "typescript",
      `import { head } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserUrl } from "#lib/user-preferences.js";

/**
 * Tool that fetches metadata for a Vercel Blob asset without downloading its content.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Use it to confirm an asset exists, or to check its size or content type before
 * downloading. Returns \`exists: false\` when the asset is not found.
 */
export default defineTool({
  description:
    "Get metadata (size, content type, upload date) for a Vercel Blob asset without " +
    "downloading it. Use to check whether an asset exists or inspect it before downloading.",
  /**
   * Look up the asset's metadata.
   *
   * @param input - Validated tool input.
   * @returns \`exists: true\` with the asset's metadata, or \`exists: false\` with an \`error\`.
   */
  async execute({ url }) {
    if (isReservedUserUrl(url)) {
      return {
        error: "User preferences are private: use get_user_preferences.",
        exists: false,
        url,
      };
    }
    try {
      const metadata = await head(url);
      return {
        contentType: metadata.contentType,
        downloadUrl: metadata.downloadUrl,
        exists: true,
        pathname: metadata.pathname,
        size: metadata.size,
        uploadedAt: metadata.uploadedAt.toISOString(),
        url: metadata.url,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Asset not found",
        exists: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Blob URL of the asset to inspect."),
  }),
  outputSchema: z.object({
    contentType: z.string().optional(),
    downloadUrl: z.string().optional(),
    error: z.string().optional(),
    exists: z.boolean(),
    pathname: z.string().optional(),
    size: z.number().optional(),
    uploadedAt: z.string().optional(),
    url: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/get_user_preferences.ts",
      "typescript",
      `import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Tool that loads the current user's saved style preferences from Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever read its own user's preferences. Returns
 * \`found: false\` with empty \`preferences\` when the user has none yet — that is a normal state,
 * not an error. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Load this user's saved preferences (standing notes that personalize how you work for " +
    "them). Call it at the start of a task; returns empty when the user has none yet.",
  /**
   * Read the current user's preferences file.
   *
   * @param _input - No input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`found\` plus the \`preferences\` Markdown (empty when none), or an \`error\`.
   */
  async execute(_input, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to load preferences for.",
        found: false,
        preferences: "",
      };
    }
    try {
      const { blobs } = await list({ limit: 1, prefix: key });
      const blob = blobs.find((b) => b.pathname === key);
      if (!blob) {
        return { found: false, preferences: "" };
      }
      const response = await fetch(blob.url);
      if (!response.ok) {
        return {
          error: \`Failed to read preferences: \${response.status} \${response.statusText}\`,
          found: false,
          preferences: "",
        };
      }
      return { found: true, preferences: await response.text() };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to load preferences",
        found: false,
        preferences: "",
      };
    }
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    error: z.string().optional(),
    found: z.boolean(),
    preferences: z.string(),
  }),
});
`,
    ),
    file(
      "agent/tools/lint_against_style.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Escape regular-expression metacharacters so a banned word is matched literally.
 *
 * @remarks
 * Banned words are read from a JSON file and interpolated into a \`RegExp\`. Without escaping,
 * an entry containing metacharacters could raise a syntax error or, worse, a
 * catastrophic-backtracking pattern (ReDoS) evaluated against caller-supplied \`text\`.
 * Escaping forces a literal, linear-time match.
 *
 * @param value - Raw banned word.
 * @returns The word with all regex metacharacters backslash-escaped.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
}

/**
 * Build a case-insensitive whole-word matcher for one banned entry.
 *
 * @remarks
 * A \`\\b\` boundary is only added at an edge whose character is a word character; \`\\b\` next to
 * punctuation (an entry like \`"agree?"\`) can never match, so such edges are left unanchored
 * instead of silently disabling the entry.
 *
 * @param value - Raw banned entry.
 * @returns A regex matching the entry literally, bounded where word boundaries exist.
 */
const STARTS_WITH_WORD_CHAR = /^\\w/;
const ENDS_WITH_WORD_CHAR = /\\w$/;

function toMatcher(value: string): RegExp {
  const leading = STARTS_WITH_WORD_CHAR.test(value) ? "\\\\b" : "";
  const trailing = ENDS_WITH_WORD_CHAR.test(value) ? "\\\\b" : "";
  return new RegExp(\`\${leading}\${escapeRegExp(value)}\${trailing}\`, "i");
}

/**
 * Maximum draft length accepted, in characters.
 *
 * @remarks
 * Bounds the work done per call and the size of accepted input. Comfortably larger than any
 * realistic draft for the supported surfaces.
 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * Schema for a \`banned-words.json\` file: a flat array of strings.
 *
 * @remarks
 * Parsed content that does not match (a non-array, or non-string elements) is rejected and
 * treated as an empty list rather than trusted.
 */
const BANNED_WORDS_SCHEMA = z.array(z.string());

/**
 * Tool that checks a draft against the active surface's banned-words list.
 *
 * @remarks
 * The banned-words list lives in the matching style skill at \`references/banned-words.json\`
 * and is read at runtime through the skill handle. The \`surface\` input is constrained to a
 * fixed enum, so the resolved skill id and file path can never be influenced by the caller.
 * Any failure to resolve, read, parse, or validate the list is treated as "no banned words"
 * rather than failing the check. Run it before proposing a draft to the writer.
 */
export default defineTool({
  description:
    "Check a draft against the surface's banned-words list and return any violations. " +
    "Run before proposing a draft to the writer.",
  /**
   * Scan \`text\` for any banned word defined by the surface's style skill.
   *
   * @param input - Validated tool input.
   * @param input.surface - Content surface whose style skill supplies the banned-words list.
   * @param input.text - Draft text to scan.
   * @param ctx - Tool runtime context, used to read the skill's reference files.
   * @returns \`ok\` (true when no banned words are present) and human-readable \`violations\`.
   */
  async execute({ surface, text }, ctx) {
    let banned: string[] = [];
    try {
      const raw = await ctx
        .getSkill(\`\${surface}-style\`)
        .file("references/banned-words.json")
        .text();
      const parsed = BANNED_WORDS_SCHEMA.safeParse(JSON.parse(raw));
      if (parsed.success) {
        banned = [...new Set(parsed.data.map((w) => w.trim()).filter(Boolean))];
      }
    } catch {
      banned = [];
    }

    const hits = banned.filter((w) => toMatcher(w).test(text));
    return {
      ok: hits.length === 0,
      violations: hits.map(
        (w) => \`Avoid "\${w}" per the \${surface} style guide.\`
      ),
    };
  },
  inputSchema: z.object({
    surface: z.enum(["x", "linkedin", "threads", "bluesky", "mastodon"]),
    text: z.string().min(1).max(MAX_TEXT_LENGTH),
  }),
});
`,
    ),
    file(
      "agent/tools/list_assets.ts",
      "typescript",
      `import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUserPath } from "#lib/user-preferences.js";

/**
 * Tool that lists assets in Vercel Blob storage, optionally filtered by path prefix.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no \`BLOB_READ_WRITE_TOKEN\`
 * is required. Use it to browse stored assets or find a specific one before downloading.
 */
export default defineTool({
  description:
    "List assets in Vercel Blob storage, optionally filtered by a path prefix. Returns each " +
    "asset's URL, size, and upload date. Use to browse stored content or locate an asset.",
  /**
   * List matching assets.
   *
   * @param input - Validated tool input.
   * @returns The matching \`assets\`, their \`count\`, a \`hasMore\` flag, and a pagination
   * \`cursor\`, or an empty list with an \`error\` message on failure.
   */
  async execute({ prefix, limit }) {
    try {
      const { blobs, hasMore, cursor } = await list({ limit, prefix });
      const visible = blobs.filter(
        (blob) => !isReservedUserPath(blob.pathname)
      );
      return {
        assets: visible.map((blob) => ({
          downloadUrl: blob.downloadUrl,
          pathname: blob.pathname,
          size: blob.size,
          uploadedAt: blob.uploadedAt.toISOString(),
          url: blob.url,
        })),
        count: visible.length,
        cursor,
        hasMore,
      };
    } catch (error) {
      return {
        assets: [],
        count: 0,
        error: error instanceof Error ? error.message : "Failed to list assets",
        hasMore: false,
      };
    }
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of assets to return. Defaults to 1000."),
    prefix: z
      .string()
      .optional()
      .describe(
        'Filter by path prefix/folder, e.g. "drafts/". Omit to list everything.'
      ),
  }),
  outputSchema: z.object({
    assets: z.array(
      z.object({
        downloadUrl: z.string(),
        pathname: z.string(),
        size: z.number(),
        uploadedAt: z.string(),
        url: z.string(),
      })
    ),
    count: z.number(),
    cursor: z.string().optional(),
    error: z.string().optional(),
    hasMore: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/post_analytics_report.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Slack chat.postMessage text hard limit, with headroom left for the code fences and labels
 * the plain-text fallback wraps around the tables.
 */
const MAX_MESSAGE_CHARS = 39_000;

/**
 * Column gutter used between cells in the plain-text fallback tables.
 */
const GUTTER = "  ";

/**
 * Largest \`page_size\` a Slack data_table block accepts; the report shows every row up to this,
 * rather than the default 5, so readers do not have to page through the digest.
 */
const MAX_PAGE_SIZE = 100;

/**
 * Matches a Slack error that points at the message blocks, so the tool knows to retry with the
 * plain-text fallback rather than give up.
 */
const BLOCK_ERROR = /block/i;

/**
 * One report table: a header row plus body rows, all cells pre-stringified by the caller.
 *
 * @remarks
 * Cells are addressed by column index; a short row is padded with blanks and any extra cells
 * beyond the column count are dropped, so a ragged row can never misalign the table. Bounds
 * (20 columns, 200 rows) stay within the Slack data_table block limits.
 */
const tableSchema = z.object({
  columns: z.array(z.string().max(200)).min(1).max(20),
  rows: z.array(z.array(z.string().max(500)).max(20)).max(200),
});

type Table = z.infer<typeof tableSchema>;

/**
 * Normalize a row to exactly \`width\` cells, so every row matches the header column count as the
 * data_table block requires.
 *
 * @param row - The caller's row cells.
 * @param width - The table's column count.
 * @returns Exactly \`width\` cell strings.
 */
const fitRow = (row: readonly string[], width: number): string[] =>
  Array.from({ length: width }, (_, column) => row[column] ?? "");

/**
 * A Slack data_table \`raw_text\` cell. Empty text is rejected by Slack, so blanks become a dash.
 *
 * @param value - The cell's string value.
 * @returns A \`raw_text\` cell object.
 */
const rawTextCell = (value: string) => ({
  text: value.trim() === "" ? "-" : value,
  type: "raw_text" as const,
});

/**
 * Build a Slack data_table block from a table, with the columns as the header row.
 *
 * @param caption - Accessible caption and visible label for the table.
 * @param table - The validated table.
 * @returns A data_table block ready for \`chat.postMessage\` \`blocks\`.
 */
const dataTableBlock = (caption: string, table: Table) => {
  const width = table.columns.length;
  const body =
    table.rows.length > 0
      ? table.rows.map((row) => fitRow(row, width).map(rawTextCell))
      : [
          Array.from({ length: width }, (_, column) =>
            rawTextCell(column === 0 ? "No data for this period" : "")
          ),
        ];
  return {
    caption,
    page_size: Math.min(MAX_PAGE_SIZE, Math.max(1, body.length)),
    rows: [table.columns.map(rawTextCell), ...body],
    type: "data_table" as const,
  };
};

/**
 * Render a table as a fixed-width monospace block for the plain-text fallback.
 *
 * @param table - The validated table.
 * @returns The table body as newline-joined rows, without the surrounding code fence.
 */
const renderTable = (table: Table): string => {
  const widths = table.columns.map((heading, column) =>
    Math.max(
      heading.length,
      ...table.rows.map((row) => (row[column] ?? "").length)
    )
  );
  const line = (cells: readonly string[]): string =>
    table.columns
      .map((_, column) => (cells[column] ?? "").padEnd(widths[column]))
      .join(GUTTER);
  const separator = widths.map((width) => "-".repeat(width)).join(GUTTER);
  return [line(table.columns), separator, ...table.rows.map(line)].join("\\n");
};

/**
 * Build the plain-text fallback message body.
 *
 * @param summary - Optional lead-in line.
 * @param postsTable - The posts table.
 * @param followersTable - The followers table.
 * @returns The message text, capped at the Slack length limit.
 */
const fallbackText = (
  summary: string | undefined,
  postsTable: Table,
  followersTable: Table
): string =>
  [
    summary,
    postsTable.rows.length > 0
      ? \`Posts\\n\\\`\\\`\\\`\\n\${renderTable(postsTable)}\\n\\\`\\\`\\\`\`
      : "Posts\\nNo posts this period.",
    \`Followers\\n\\\`\\\`\\\`\\n\${renderTable(followersTable)}\\n\\\`\\\`\\\`\`,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\\n\\n")
    .slice(0, MAX_MESSAGE_CHARS);

/**
 * Tool that posts the weekly Typefully analytics digest to the team's analytics Slack channel.
 *
 * @remarks
 * Posts the digest only to the channel in \`TYPEFULLY_ANALYTICS_CHANNEL\`, never a model-supplied
 * channel. Renders the tables as Slack \`data_table\` blocks, retrying once as fixed-width text if
 * Slack rejects the blocks. The bot token comes from the Slack channel's Vercel Connect
 * credentials, so no Slack secret lives in code.
 */
export default defineTool({
  description:
    "Post the weekly Typefully analytics digest, a posts table and a followers table, to the " +
    "team's analytics Slack channel. Use this when the user asks for an analytics report. Build " +
    "each table from the analytics tools and pass every cell as a string.",
  async execute({ summary, postsTable, followersTable }) {
    const channel = process.env.TYPEFULLY_ANALYTICS_CHANNEL;
    if (!channel) {
      return {
        error: "TYPEFULLY_ANALYTICS_CHANNEL is not set.",
        posted: false,
      };
    }
    const text = fallbackText(summary, postsTable, followersTable);
    const postsBlock =
      postsTable.rows.length > 0
        ? dataTableBlock("Posts", postsTable)
        : {
            text: { text: "No posts this period.", type: "mrkdwn" as const },
            type: "section" as const,
          };
    const blocks = [
      ...(summary
        ? [
            {
              text: { text: summary, type: "mrkdwn" as const },
              type: "section" as const,
            },
          ]
        : []),
      postsBlock,
      dataTableBlock("Followers", followersTable),
    ];
    try {
      const { botToken } = connectSlackCredentials(
        process.env.SLACK_CONNECTOR ?? "slack/social-media-agent"
      );
      const post = (body: Record<string, unknown>) =>
        callSlackApi({
          body: { channel, unfurl_links: false, ...body },
          botToken,
          operation: "chat.postMessage",
        });
      const withBlocks = await post({ blocks, text });
      if (withBlocks.ok === true) {
        return { channel, posted: true };
      }
      const error = String(withBlocks.error ?? "unknown_error");
      if (!BLOCK_ERROR.test(error)) {
        return { error, posted: false };
      }
      const textOnly = await post({ text });
      return textOnly.ok === true
        ? { channel, posted: true, usedTextFallback: true }
        : { error: String(textOnly.error ?? "unknown_error"), posted: false };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Slack post failed",
        posted: false,
      };
    }
  },
  inputSchema: z.object({
    followersTable: tableSchema.describe(
      "Follower analytics: one row per social account or period, cells as strings."
    ),
    postsTable: tableSchema.describe(
      "Post analytics: one row per post, cells as strings."
    ),
    summary: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "Summary of the report, 1-2 sentences. Write this in a casual tone."
      ),
  }),
  outputSchema: z.object({
    channel: z.string().optional(),
    error: z.string().optional(),
    posted: z.boolean(),
    usedTextFallback: z.boolean().optional(),
  }),
});
`,
    ),
    file(
      "agent/tools/save_user_preferences.ts",
      "typescript",
      `import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { userPreferencesKey } from "#lib/user-preferences.js";

/**
 * Maximum size of a user-preferences document, in characters.
 *
 * @remarks
 * Preferences are a short, curated set of standing notes — not a transcript. The bound keeps the
 * file small and cheap to load into context on every draft.
 */
const MAX_PREFERENCES_LENGTH = 20_000;

/**
 * Tool that saves the current user's style preferences to Vercel Blob.
 *
 * @remarks
 * The Blob key is derived from the framework-resolved principal (\`ctx.session.auth.current\`),
 * never from model input, so a session can only ever write its own user's preferences. This
 * overwrites the whole document, so the caller should \`get_user_preferences\` first, integrate
 * the new standing preference, and save the merged result — keeping the file curated rather than
 * append-only. Authorization resolves from the ambient Vercel OIDC credentials.
 */
export default defineTool({
  description:
    "Save this user's standing preferences (Markdown). Overwrites the whole document, so " +
    "load the current preferences first, merge in the new one, then save. Use only for durable " +
    "preferences the user states, not one-off instructions for a single task.",
  /**
   * Write the current user's preferences file.
   *
   * @param input - Validated tool input.
   * @param ctx - Tool runtime context; supplies the resolved principal.
   * @returns \`success: true\` with the stored \`pathname\`, or \`success: false\` with an \`error\`.
   */
  async execute({ preferences }, ctx) {
    const key = userPreferencesKey(ctx.session.auth.current);
    if (!key) {
      return {
        error: "No signed-in user to save preferences for.",
        success: false,
      };
    }
    try {
      const blob = await put(key, preferences, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "text/markdown",
      });
      return { pathname: blob.pathname, success: true };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to save preferences",
        success: false,
      };
    }
  },
  inputSchema: z.object({
    preferences: z
      .string()
      .min(1)
      .max(MAX_PREFERENCES_LENGTH)
      .describe(
        "The full preferences document as Markdown: the merged result, not just the new note."
      ),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    pathname: z.string().optional(),
    success: z.boolean(),
  }),
});
`,
    ),
    file(
      "agent/tools/upload_asset.ts",
      "typescript",
      `import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  isReservedUserPath,
  USER_PREFERENCES_PREFIX,
} from "#lib/user-preferences.js";

/**
 * Tool that uploads text or binary content to Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel credentials — the project's OIDC token
 * (\`VERCEL_OIDC_TOKEN\`, or the \`x-vercel-oidc-token\` request header on Vercel) — so no
 * \`BLOB_READ_WRITE_TOKEN\` is required and no token is passed in code. Binary content (images,
 * PDFs) is supplied base64-encoded with \`isBase64: true\`.
 */
export default defineTool({
  description:
    "Upload text or binary content to Vercel Blob storage and return its URL. Use when the " +
    "user wants to save or publish an asset, such as an exported draft or an image, to durable storage.",
  /**
   * Upload the content to Blob storage.
   *
   * @param input - Validated tool input.
   * @returns The asset's \`url\`, \`downloadUrl\`, stored \`pathname\`, and \`contentType\`, or
   * \`success: false\` with an \`error\` message.
   */
  async execute({
    pathname,
    content,
    contentType,
    isBase64,
    access,
    addRandomSuffix,
    allowOverwrite,
  }) {
    if (isReservedUserPath(pathname)) {
      return {
        contentType: contentType ?? "unknown",
        downloadUrl: "",
        error: \`"\${USER_PREFERENCES_PREFIX}" is reserved: use save_user_preferences instead.\`,
        pathname,
        success: false,
        url: "",
      };
    }
    try {
      const body = isBase64 ? Buffer.from(content, "base64") : content;
      const blob = await put(pathname, body, {
        access: access ?? "public",
        addRandomSuffix: addRandomSuffix ?? false,
        allowOverwrite: allowOverwrite ?? false,
        contentType,
      });
      return {
        contentType: blob.contentType,
        downloadUrl: blob.downloadUrl,
        pathname: blob.pathname,
        success: true,
        url: blob.url,
      };
    } catch (error) {
      return {
        contentType: contentType ?? "unknown",
        downloadUrl: "",
        error: error instanceof Error ? error.message : "Upload failed",
        pathname,
        success: false,
        url: "",
      };
    }
  },
  inputSchema: z.object({
    access: z
      .enum(["public", "private"])
      .optional()
      .describe('Access level for the asset. Defaults to "public".'),
    addRandomSuffix: z
      .boolean()
      .optional()
      .describe(
        "Append a random suffix to avoid pathname collisions. Defaults to false."
      ),
    allowOverwrite: z
      .boolean()
      .optional()
      .describe(
        "Allow overwriting an existing blob at the same pathname. Defaults to false."
      ),
    content: z
      .string()
      .describe(
        "Raw text/JSON, or base64-encoded bytes when isBase64 is true."
      ),
    contentType: z
      .string()
      .optional()
      .describe(
        'MIME type, e.g. "text/markdown". Inferred from the extension when omitted.'
      ),
    isBase64: z
      .boolean()
      .optional()
      .describe(
        "Set true when content is base64-encoded binary data. Defaults to false."
      ),
    pathname: z
      .string()
      .min(1)
      .describe(
        'Path and filename including extension, e.g. "drafts/launch-post.md".'
      ),
  }),
  outputSchema: z.object({
    contentType: z.string(),
    downloadUrl: z.string(),
    error: z.string().optional(),
    pathname: z.string(),
    success: z.boolean(),
    url: z.string(),
  }),
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
