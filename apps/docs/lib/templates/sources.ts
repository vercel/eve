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
