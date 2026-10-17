// Curation manifest for the templates gallery and detail pages. Repository
// content is resolved from this manifest during docs development and production builds.

export type TemplateCategory = "Chat" | "Collaboration" | "Example" | "Marketing";

export type TemplateIntegration =
  | "Contentful"
  | "Datadog"
  | "dbt"
  | "GitHub"
  | "HTTP API"
  | "Linear"
  | "Linq"
  | "Mux"
  | "MotherDuck"
  | "Notion"
  | "Postgres"
  | "Resend"
  | "Sanity"
  | "Sentry"
  | "Slack"
  | "Stripe Link"
  | "Typefully"
  | "Vercel"
  | "Voice"
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
  featured?: boolean;
  /** Hide from the gallery while keeping the detail page available. */
  unlisted?: boolean;
  description: string;
  descriptionLink?: { text: string; href: string };
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
    title: "Web Chat Agent",
    featured: true,
    setupPrompt:
      "Set up the eve chat template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-chat-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A persisted Next.js chat template for eve, with per-user long-term memory, Better Auth, Drizzle, Neon, and Upstash Redis.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-chat-template",
    category: "Chat",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Web chat", "Slack"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-chat-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/memory/profile.ts",
      "agent/skills/plan_a_trip.md",
      "agent/tools/get_weather.ts",
    ],
  },
  {
    slug: "eve-agent-with-python",
    title: "Full Stack Agent with Python Backend",
    setupPrompt:
      "Set up the eve agent with Python template in my current workspace using https://github.com/vercel-labs/eve-agent-python-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the required Python, uv, password, database, and Vercel setup steps.",
    description:
      "A Next.js web chat with a Python FastAPI backend, where an eve agent manages a shared task list and runs Python tools for statistics and text analysis.",
    sourceHref: "https://github.com/vercel-labs/eve-agent-python-template/tree/main",
    category: "Chat",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Web chat", "Postgres", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-agent-python-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/instructions.md",
      "agent/lib/backend.ts",
      "agent/tools/create_task.ts",
      "agent/tools/compute_stats.ts",
      "agent/tools/analyze_text.ts",
      "vercel.ts",
    ],
  },
  {
    slug: "eve-voice-template",
    title: "Voice Agent",
    setupPrompt:
      "Set up the eve voice template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-voice-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A Next.js voice app where GPT-Live-1 on AI Gateway handles listening and speaking while your eve agent runs tools, asks for approvals, and keeps durable state.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-voice-template",
    category: "Chat",
    model: "anthropic/claude-haiku-5.5",
    integrations: ["Voice", "Web chat"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-voice-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/instructions.md",
      "agent/tools/create_reminder.ts",
      "agent/tools/get_weather.ts",
      "apps/web/app/api/live/client-secret/route.ts",
      "apps/web/components/voice-call.tsx",
    ],
  },
  {
    slug: "eve-slack-agent",
    title: "Slack Assistant",
    setupPrompt:
      "Set up the eve Slack agent template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-slack-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-slack-agent-template",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-slack-agent-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/skills/plan_a_trip.md",
      "agent/tools/get_weather.ts",
    ],
  },
  {
    slug: "eve-company-brain-template",
    title: "Company Brain",
    featured: true,
    setupPrompt:
      "Set up the eve company brain template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template as the source. Copy the project files, install its dependencies, and follow the README to build the sample data and configure Slack. Preserve the existing project if the workspace is not empty. Use local DuckDB for development and explain how to switch to MotherDuck when deployed, including separate writer and read-only credentials and Slack access allowlists.",
    description:
      "Answer employees' business questions in Slack using documented dbt models, with local DuckDB or deployed MotherDuck and a Jaffle Shop sample dataset.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack", "dbt", "MotherDuck"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-company-brain-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/tools/list_models.ts",
      "agent/tools/get_model.ts",
      "agent/tools/query_sql.ts",
      "agent/lib/query.ts",
    ],
  },
  {
    slug: "eve-data-analyst-template",
    title: "Data Analyst",
    setupPrompt:
      "Set up the eve data analyst template in my current workspace using https://github.com/vercel-labs/eve-data-analyst-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required database, Slack, and Vercel setup steps.",
    description:
      "A Slack-based data analyst that answers business questions from Postgres, with charts and tables for useful results.",
    sourceHref: "https://github.com/vercel-labs/eve-data-analyst-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-opus-5.5",
    integrations: ["Slack", "Postgres", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-data-analyst-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/skills/metric-definitions.md",
      "agent/tools/describe_schema.ts",
      "agent/tools/run_sql.ts",
      "agent/tools/post_slack_chart.ts",
    ],
  },
  {
    slug: "eve-contentful-agent-template",
    title: "Contentful Assistant",
    setupPrompt:
      "Set up the eve Contentful agent template in my current workspace using https://github.com/vercel-labs/eve-contentful-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required Contentful, Slack, and Vercel setup steps.",
    description:
      "A Slack-based Contentful assistant that searches, drafts, and edits entries, with approval before publishing content.",
    sourceHref: "https://github.com/vercel-labs/eve-contentful-agent-template/tree/main",
    category: "Collaboration",
    model: "openai/gpt-6.1-sol-fast",
    integrations: ["Slack", "Contentful", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-contentful-agent-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/schedules/contentful-mirror-nightly.ts",
      "agent/skills/contentful-query.ts",
      "agent/tools/search_contentful_entries.ts",
      "agent/tools/update_contentful_fields.ts",
      "agent/tools/publish_contentful_entry.ts",
    ],
  },
  {
    slug: "eve-vercel-drives-starter",
    title: "Team Knowledge Assistant",
    setupPrompt:
      "Set up the eve Vercel Drives starter in my current workspace using https://github.com/vercel-labs/eve-vercel-drives-starter as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the Slack and Vercel setup steps.",
    description:
      "An eve agent that searches files on a Vercel Drive and saves new notes or documents, through Slack or the terminal.",
    sourceHref: "https://github.com/vercel-labs/eve-vercel-drives-starter/tree/main",
    category: "Collaboration",
    model: "openai/gpt-6.1-sol-fast",
    integrations: ["Slack", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-vercel-drives-starter", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/lib/drive.ts",
      "agent/sandbox.ts",
      "agent/tools/save_to_drive.ts",
    ],
  },
  {
    slug: "eve-memory-agent-template",
    title: "Memory Agent",
    setupPrompt:
      "Set up the eve memory agent template in my current workspace using https://github.com/vercel-labs/eve-memory-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required Slack and Vercel setup steps.",
    description:
      "A Slack assistant that remembers each user's preferences and shared channel conventions in separate long-term memories.",
    sourceHref: "https://github.com/vercel-labs/eve-memory-agent-template/tree/main",
    category: "Collaboration",
    model: "openai/gpt-6.1-sol-fast",
    integrations: ["Slack", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-memory-agent-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/memory/channel-preferences.ts",
      "agent/memory/user-preferences.ts",
      "agent/tools/agent.ts",
    ],
  },
  {
    slug: "eve-tanstack-start-template",
    title: "TanStack Start Chat",
    setupPrompt:
      "Set up the eve TanStack Start template in my current workspace using https://github.com/vercel-labs/eve-tanstack-start-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required password and deployment setup steps.",
    description:
      "A password-protected web chat built with eve and TanStack Start, with generative UI for search results, forms, and data tables.",
    sourceHref: "https://github.com/vercel-labs/eve-tanstack-start-template/tree/main",
    category: "Chat",
    model: "openai/gpt-6.1-sol-fast",
    integrations: ["Web chat", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-tanstack-start-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/instructions.md",
      "agent/sandbox.ts",
      "agent/tools/ask_question.ts",
      "agent/tools/render_ui.ts",
      "apps/web/app/routes/index.tsx",
      "apps/web/app/_components/agent-chat.tsx",
    ],
  },
  {
    slug: "eve-software-factory-template",
    title: "Software Factory",
    featured: true,
    setupPrompt:
      "I want to build a software factory with the eve framework, using the Foreman template. Read the setup instructions at https://ask-foreman.dev/docs/getting-started and follow them. They cover deploying the template, connecting GitHub and Linear, running it locally, and how the pipeline works overall.",
    description:
      "Foreman, a software factory that takes tasks from GitHub and Linear, runs each through classifier, analyst, implementer, and reviewer stations, and delivers a reviewed draft pull request on your repository.",
    sourceHref: "https://github.com/vercel-labs/eve-software-factory-template/tree/main",
    category: "Collaboration",
    model: "openai/gpt-5.6-terra-fast",
    integrations: ["GitHub", "Linear"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-software-factory-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/github.ts",
      "agent/channels/linear.ts",
      "agent/extensions/github.ts",
      "agent/instructions.ts",
      "agent/lib/github/approval.ts",
      "agent/lib/trust.ts",
      "agent/subagents/analyst/agent.ts",
      "agent/subagents/classifier/agent.ts",
      "agent/subagents/implementer/agent.ts",
      "agent/subagents/implementer/tools/push_branch.ts",
      "agent/subagents/reviewer/agent.ts",
    ],
  },
  {
    slug: "marketing-team-eve-template",
    title: "Marketing Team Coordinator",
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
    slug: "openinstinct-eve-template",
    title: "iMessage Agent as a Service",
    setupPrompt:
      "I want to build a multi-tenant iMessage agent service with eve, using OpenInstinct at https://github.com/Merit-Systems/OpenInstinct. Read its README and follow its deployment instructions. Preserve the existing project if my workspace is not empty. Explain the required Linq, Kernel, database, storage, and model provider setup, and distinguish optional account integrations from required services. Call out the repository's warning that the application is not intended for production use.",
    description:
      "OpenInstinct, a multi-tenant iMessage agent service built with eve and Linq, with user accounts, scoped memory, an encrypted vault, cloud browser automation, and Stripe Link wallet integration.",
    descriptionLink: { text: "Stripe Link", href: "https://stripe.com/payments/link" },
    sourceHref: "https://github.com/Merit-Systems/OpenInstinct/tree/main",
    category: "Example",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Linq", "Stripe Link", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "Merit-Systems", repo: "OpenInstinct", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/channels/linq.ts",
      "agent/extensions/link.ts",
      "agent/instructions.md",
      "agent/lib/principal-scope.ts",
      "agent/memory/profile.ts",
      "agent/tools/run_browser.ts",
      "agent/subagents/browser-agent/agent.ts",
    ],
  },
  {
    slug: "kody-eve-template",
    title: "GitHub Project Maintainer",
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
    slug: "typefully-eve-template",
    title: "Social Media Manager",
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
    slug: "eve-sre-agent-template",
    title: "Incident Investigation Assistant",
    setupPrompt:
      "I want to set up sre, an incident response agent built with the eve framework. Read the setup instructions at https://github.com/vercel-labs/eve-sre-agent-template/blob/main/docs/setup-for-agents.md and follow them. They cover creating and linking the Vercel project, connecting Slack, GitHub, Datadog, and Vercel, deploying the agent, and verifying it in Slack.",
    description:
      "sre, an incident response agent that investigates alerts from Slack or webhooks using live Datadog, GitHub, and Vercel evidence, with read-only access by default.",
    sourceHref: "https://github.com/vercel-labs/eve-sre-agent-template/tree/main",
    category: "Collaboration",
    model: "openai/gpt-5.6-terra",
    integrations: ["Slack", "Datadog", "GitHub", "Vercel", "HTTP API"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-sre-agent-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/channels/webhook.ts",
      "agent/connections/datadog.ts",
      "agent/connections/vercel.ts",
      "agent/extensions/github.ts",
      "agent/instructions/instructions.md",
      "agent/lib/webhook/route.ts",
      "agent/skills/deep-investigation/SKILL.md",
      "agent/skills/hypothesis-validation/SKILL.md",
      "agent/tools/evidence_record.ts",
      "agent/tools/watch_slack_channel.ts",
    ],
  },
  {
    slug: "sanity-copilot-eve-template",
    title: "Sanity Content Assistant",
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
    slug: "eve-design-template",
    title: "Company Design Assistant",
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
      "agent/tools/web_fetch.ts",
      "agent/tools/web_search.ts",
      "agent/tools/write_file.ts",
    ],
  },
  {
    slug: "eve-llm-council-template",
    title: "Council of Agents",
    unlisted: true,
    setupPrompt:
      "Set up the LLM council template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-llm-council-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A Next.js LLM council that sends one prompt to four models in parallel, streams their answers, and asks a judge model for a concise answer with per-model agreement scores.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-llm-council-template",
    category: "Example",
    model: "anthropic/claude-opus-5",
    integrations: ["Web chat"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-llm-council-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/instructions.md",
      "agent/lib/schemas.ts",
      "agent/subagents/claude/agent.ts",
      "agent/subagents/grok/agent.ts",
      "agent/subagents/kimi/agent.ts",
      "agent/subagents/openai/agent.ts",
    ],
  },
  {
    slug: "mux-video-agent",
    title: "Video Production Assistant",
    unlisted: true,
    setupPrompt:
      "Set up the Mux Video Agent template in my current workspace using https://github.com/muxinc/mux-video-agent as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the required Mux credentials, AI Gateway setup, and manual deployment steps.",
    description:
      "A durable video agent that creates and inspects Mux assets, makes clips, and runs supported Mux Robots workflows with human approval for write actions.",
    sourceHref: "https://github.com/muxinc/mux-video-agent",
    category: "Example",
    model: "openai/gpt-5.6-luna",
    integrations: ["Mux"],
    source: "GitHub",
    github: { owner: "muxinc", repo: "mux-video-agent", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/extensions/mux_video.ts",
      "agent/instructions.md",
      "packages/eve-video/extension/extension.ts",
      "packages/eve-video/extension/instructions.md",
      "packages/eve-video/extension/skills/workflows/SKILL.md",
      "packages/eve-video/extension/tools/create_asset.ts",
      "packages/eve-video/extension/tools/create_clip.ts",
      "packages/eve-video/extension/tools/run_workflow.ts",
    ],
  },
  {
    slug: "weather-agent-fixture",
    title: "Weather",
    unlisted: true,
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
