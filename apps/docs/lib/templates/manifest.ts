// Curation manifest for the templates gallery. Repository content is resolved
// from this manifest during docs development and production builds.

export type TemplateCategory = "Chat" | "Collaboration" | "Example" | "Marketing";

export type TemplateIntegration =
  | "GitHub"
  | "HTTP API"
  | "Linear"
  | "Notion"
  | "Resend"
  | "Sanity"
  | "Sentry"
  | "Slack"
  | "Typefully"
  | "Web chat";

export type TemplateSource = "GitHub" | "Vercel Templates";

export interface TemplateGitHubSource {
  owner: string;
  repo: string;
  /** Branch, tag, or SHA. Resolved to a commit SHA by `templates:sync`. */
  ref: string;
  /** Directory within the repo the template lives in, for monorepo sources. */
  pathPrefix?: string;
}

export interface TemplateManifestEntry {
  slug: string;
  title: string;
  description: string;
  demoHref?: string;
  category: TemplateCategory;
  integrations: TemplateIntegration[];
  model: string;
  source: TemplateSource;
  sourceHref: string;
  setupPrompt: string;
  github: TemplateGitHubSource;
  /** Exact paths (relative to `github.pathPrefix`) to embed in the file viewer. */
  files: string[];
}

export const templateManifest: TemplateManifestEntry[] = [
  {
    slug: "eve-chat-template",
    title: "Chat",
    setupPrompt:
      "Set up the eve chat template in my current workspace using https://github.com/vercel-labs/eve-chat-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    demoHref: "https://eve-chat-template.labs.vercel.dev",
    sourceHref: "https://github.com/vercel-labs/eve-chat-template/tree/main",
    category: "Chat",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Web chat", "Slack", "Linear", "Notion", "Sentry"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-chat-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/channels/slack.ts",
      "agent/connections/linear.ts",
      "agent/connections/notion.ts",
      "agent/connections/sentry.ts",
      "agent/instructions.md",
      "agent/skills/plan_a_trip.md",
      "agent/tools/get_weather.ts",
    ],
  },
  {
    slug: "eve-design-template",
    title: "Design",
    setupPrompt:
      "Set up the eve design agent template in my current workspace using https://github.com/vercel-labs/eve-design-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README and BOOTSTRAP.md to configure it. Preserve the existing project if the workspace is not empty, tell me about any required environment variables or manual setup steps, and do not approve or publish the design corpus for me.",
    description:
      "A Slack design collaborator that answers from a reviewed, versioned corpus of your organization's approved design guidance.",
    sourceHref: "https://github.com/vercel-labs/eve-design-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-4.6",
    integrations: ["Slack"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-design-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/sandbox/sandbox.ts",
      "agent/skills/design-knowledge/SKILL.md",
      "agent/tools/agent.ts",
      "agent/tools/bash.ts",
      "agent/tools/todo.ts",
      "agent/tools/web_fetch.ts",
      "agent/tools/web_search.ts",
      "agent/tools/write_file.ts",
    ],
  },
  {
    slug: "eve-slack-agent",
    title: "Slack",
    setupPrompt:
      "Set up the eve Slack agent template in my current workspace using https://github.com/vercel-labs/eve-slack-agent-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    sourceHref: "https://github.com/vercel-labs/eve-slack-agent-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-slack-agent-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/skills/plan_a_trip.md",
      "agent/tools/get_weather.ts",
    ],
  },
  {
    slug: "kody-eve-template",
    title: "GitHub maintainer",
    setupPrompt:
      "I want to build a GitHub maintainer agent with the eve framework, using the Kody template. Read the setup instructions at https://agent-resources.dev/kody-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "Kody, a personal GitHub maintainer agent that emails you a weekly digest of open issues, acts on your email replies, summarizes new pull requests, answers @mentions, and works delegated Linear issues.",
    sourceHref: "https://github.com/vercel-labs/kody-eve-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-fable-5",
    integrations: ["GitHub", "Linear", "Resend"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "kody-eve-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/github.ts",
      "agent/channels/linear.ts",
      "agent/channels/resend.ts",
      "agent/connections/linear.ts",
      "agent/connections/resend.ts",
      "agent/instructions.ts",
      "agent/schedules/weekly-digest.ts",
      "agent/skills/triaging-issues/SKILL.md",
      "agent/subagents/researcher/agent.ts",
      "agent/tools/github.ts",
    ],
  },
  {
    slug: "marketing-team-eve-template",
    title: "Marketing team",
    setupPrompt:
      "I want to build a team of marketing agents with the eve framework, using the marketing team template. Read the setup instructions at https://agent-resources.dev/marketing-team-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A team of marketing agents: a lead routes work to specialists for positioning, long-form content, social, SEO, and email, publishing through Notion, Typefully, and Resend.",
    sourceHref: "https://github.com/vercel-labs/marketing-team-eve-template/tree/main",
    category: "Marketing",
    model: "anthropic/claude-opus-5",
    integrations: ["Web chat", "Slack", "Notion", "Resend", "Typefully"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "marketing-team-eve-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/connections/notion.ts",
      "agent/instructions.md",
      "agent/subagents/content-marketer/agent.ts",
      "agent/subagents/email/agent.ts",
      "agent/subagents/product-marketer/agent.ts",
      "agent/subagents/seo/agent.ts",
      "agent/subagents/social-media-coordinator/agent.ts",
    ],
  },
  {
    slug: "sanity-copilot-eve-template",
    title: "Sanity copilot",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Sanity copilot template. Read the setup instructions at https://agent-resources.dev/sanity-copilot-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A Slack-based Sanity copilot that queries and edits content with GROQ, inspects and shapes schemas, manages drafts and releases, and drafts long-form pieces into Notion.",
    sourceHref: "https://github.com/vercel-labs/sanity-copilot-eve-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack", "Sanity", "Notion"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "sanity-copilot-eve-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/connections/notion.ts",
      "agent/connections/sanity.ts",
      "agent/instructions.md",
      "agent/sandbox.ts",
      "agent/skills/sanity-best-practices/SKILL.md",
      "agent/subagents/researcher/agent.ts",
      "agent/subagents/reviewer/agent.ts",
      "agent/tools/upload_asset.ts",
    ],
  },
  {
    slug: "typefully-eve-template",
    title: "Social media",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Typefully social media agent template. Read the setup instructions at https://agent-resources.dev/typefully-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A Slack-based social media agent that drafts posts and threads for X, LinkedIn, Threads, Bluesky, and Mastodon through Typefully, manages the publishing queue, and pulls briefs from Notion.",
    sourceHref: "https://github.com/vercel-labs/typefully-eve-template/tree/main",
    category: "Marketing",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack", "Typefully", "Notion"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "typefully-eve-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/connections/notion.ts",
      "agent/connections/typefully.ts",
      "agent/instructions.md",
      "agent/sandbox.ts",
      "agent/schedules/weekly-analytics.ts",
      "agent/skills/x-style/SKILL.md",
      "agent/subagents/researcher/agent.ts",
      "agent/subagents/reviewer/agent.ts",
      "agent/tools/lint_against_style.ts",
    ],
  },
  {
    slug: "weather-agent-fixture",
    title: "Weather",
    setupPrompt:
      "Set up the eve weather agent in my current workspace using https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent as the source. Copy that fixture into a standalone project, install its dependencies, and make any minimal changes needed to run it outside the eve monorepo. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
    category: "Example",
    model: "anthropic/claude-sonnet-5",
    integrations: ["HTTP API"],
    source: "GitHub",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/fixtures/weather-agent",
    },
    files: [
      "agent/agent.ts",
      "agent/instructions.md",
      "agent/skills/get-weather.md",
      "agent/tools/get_weather.ts",
    ],
  },
];
