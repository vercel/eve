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
import { VercelSandbox } from 'eve/sandbox/vercel';

export default defineSandbox(() => {
  return VercelSandbox.create({
    networkPolicy: 'deny-all',
  });
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
