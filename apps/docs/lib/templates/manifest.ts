// Curation manifest for the templates gallery and detail pages. Repository
// content is resolved from this manifest during docs development and production builds.

export type TemplateCategory = "Chat" | "Collaboration" | "Example" | "Marketing";

export type TemplateIntegration =
  | "Contentful"
  | "Datadog"
  | "Discord"
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

export type TemplatePreviewSurface = "github" | "imessage" | "slack" | "voice" | "web";

export interface TemplatePreviewMessage {
  from: "agent" | "user";
  /**
   * Plain text. On the `slack` and `github` surfaces, `code`, [label](url),
   * and @mentions render in that app's styles (`github` also links #123
   * references); other surfaces show text as written. For a `labeled`
   * event, the label name.
   */
  text: string;
  /**
   * Tool or skill names shown as completed calls. Each must match a path in
   * `files`. Only the `web` and `voice` surfaces render them; Slack and
   * iMessage do not show tool calls.
   */
  tools?: string[];
  /** Slack only: something the agent posts under the text. */
  attachment?: TemplatePreviewAttachment;
  /**
   * GitHub only: render a timeline event instead of a comment. `labeled`
   * shows "<user> added the <text> label".
   */
  event?: "labeled";
}

/**
 * A Slack message part beyond text. Use one only when the template's agent
 * really posts it: a Markdown table, a native chart, eve's task card for
 * subagent work, a link preview Slack unfurls, or Approve and Cancel buttons
 * for a tool with `approval`.
 */
export type TemplatePreviewAttachment =
  /** The first row is the header. */
  | { type: "table"; rows: string[][] }
  /** A line chart of `values`, oldest first. */
  | { type: "chart"; title: string; values: number[] }
  /** eve's task card. One task renders without `title`, as eve does. */
  | { type: "tasks"; title?: string; tasks: { title: string; output?: string }[] }
  | { type: "link"; site: TemplateIntegration; title: string; description?: string }
  /** Approve and Cancel buttons. Ask the question in the message text. */
  | {
      type: "approval";
      /** Label for the approve button. Defaults to `Approve`. */ approve?: string;
    };

/**
 * A short sample conversation rendered on the gallery card in the style of
 * `surface`. Only the first few messages are visible. Templates without a
 * preview get a placeholder built from `integrations`.
 */
export interface TemplatePreview {
  surface: TemplatePreviewSurface;
  /** Display name for the agent. Defaults to the template title. */
  agent?: string;
  /**
   * Square avatar image for the agent, relative to `public/`, such as
   * `/templates/icons/acme.svg`. It is cropped to a circle or rounded square,
   * so leave padding around the mark. Defaults to the eve logo.
   */
  icon?: string;
  /** Slack channel name, or the web chat or voice app URL shown in the window header. */
  context?: string;
  /** GitHub only: the issue or pull request the conversation happens on. */
  thread?: TemplatePreviewThread;
  /**
   * GitHub only: show the messages as a review thread on this added line
   * instead of the issue timeline.
   */
  review?: { line: number; code: string };
  messages: TemplatePreviewMessage[];
}

export interface TemplatePreviewThread {
  kind: "issue" | "pull";
  number: number;
  title: string;
  /** Pull requests only: show the gray Draft state instead of Open. */
  draft?: boolean;
}

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
  /** One-line summary for the gallery card, about 40 characters. Listed templates need one. */
  tagline?: string;
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
  preview?: TemplatePreview;
}

export const templateManifest: TemplateManifestEntry[] = [
  {
    slug: "eve-chat-template",
    title: "Web Chat Agent",
    featured: true,
    setupPrompt:
      "Set up the eve chat template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-chat-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    tagline: "Next.js chat with per-user memory",
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
    preview: {
      surface: "web",
      icon: "/templates/icons/web-chat.svg",
      context: "trips.example.com",
      messages: [
        {
          from: "user",
          text: "Plan a weekend in Lisbon for me, November 14 to 15. I'm vegetarian.",
        },
        {
          from: "agent",
          tools: ["plan_a_trip", "get_weather"],
          text: "Saved that you're vegetarian. Saturday: Alfama and the castle, then dinner in Príncipe Real. Sunday: pastries in Belém and the LX Factory market.",
        },
      ],
    },
  },
  {
    slug: "eve-agent-with-python",
    title: "Full Stack Agent with Python Backend",
    setupPrompt:
      "Set up the eve agent with Python template in my current workspace using https://github.com/vercel-labs/eve-agent-python-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the required Python, uv, password, database, and Vercel setup steps.",
    tagline: "Next.js chat on a FastAPI backend",
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
    preview: {
      surface: "web",
      context: "tasks.example.com",
      messages: [
        { from: "user", text: "How's my task list looking this week? Anything overdue?" },
        {
          from: "agent",
          tools: ["compute_stats"],
          text: "7 open, 3 due this week, none overdue. The oldest is ship v2 docs, open for 12 days. You close about 9 a week, so you're on pace.",
        },
      ],
    },
  },
  {
    slug: "eve-voice-template",
    title: "Voice Agent",
    setupPrompt:
      "Set up the eve voice template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-voice-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    tagline: "Real-time voice calls with your agent",
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
    preview: {
      surface: "voice",
      context: "voice.example.com",
      messages: [
        { from: "user", text: "What time is a 3 PM Pacific call in London?" },
        {
          from: "agent",
          text: "11 PM in London. If you want them awake, try 8 AM Pacific, which is 4 PM there.",
        },
      ],
    },
  },
  {
    slug: "eve-slack-agent",
    title: "Slack Assistant",
    setupPrompt:
      "Set up the eve Slack agent template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-slack-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    tagline: "A starter Slack agent, ready to deploy",
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
    preview: {
      surface: "slack",
      agent: "assistant",
      icon: "/templates/icons/slack-assistant.svg",
      context: "general",
      messages: [
        {
          from: "user",
          text: "@assistant draft a quick note moving Friday's launch review to Tuesday",
        },
        {
          from: "agent",
          text: "“Heads up: we're moving Friday's launch review to Tuesday at 10 so QA can finish the payments tests. Same link and agenda. Shout if Tuesday doesn't work.”",
        },
      ],
    },
  },
  {
    slug: "eve-discord-agent",
    title: "Discord Agent",
    tagline: "Answers and catch-ups in Discord threads",
    setupPrompt:
      "Set up the eve Discord agent template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-discord-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the Discord bot, Vercel Connect, and Vercel Daemon setup steps.",
    description:
      "A Discord community agent that answers questions in threads, catches people up on what they missed, and stays quiet while they talk, through a Discord Gateway relay on Vercel Daemons.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-discord-agent-template",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Discord", "Vercel"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-discord-agent-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/discord.ts",
      "agent/instructions.md",
      "agent/skills/catch_up.md",
      "agent/tools/read_recent_messages.ts",
    ],
  },
  {
    slug: "eve-company-brain-template",
    title: "Company Brain",
    featured: true,
    setupPrompt:
      "Set up the eve company brain template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template as the source. Copy the project files, install its dependencies, and follow the README to build the sample data and configure Slack. Preserve the existing project if the workspace is not empty. Use local DuckDB for development and explain how to switch to MotherDuck when deployed, including separate writer and read-only credentials and Slack access allowlists.",
    tagline: "Business answers in Slack from dbt",
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
    preview: {
      surface: "slack",
      agent: "brain",
      icon: "/templates/icons/company-brain.svg",
      context: "ask-data",
      messages: [
        { from: "user", text: "@brain how many orders did we have in October?" },
        {
          from: "agent",
          text: "1,284 orders in October 2026, up 9% from September.",
          attachment: {
            type: "table",
            rows: [
              ["Month", "Orders", "Revenue"],
              ["Sep 2026", "1,178", "$56.6K"],
              ["Oct 2026", "1,284", "$61.7K"],
            ],
          },
        },
      ],
    },
  },
  {
    slug: "eve-coding-agent-template",
    title: "Coding Agent on Slack",
    setupPrompt:
      "Set up the eve coding agent template in my current workspace using https://github.com/vercel/eve/tree/main/apps/templates/eve-coding-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the required Slack, GitHub, and Vercel setup steps.",
    tagline: "Bug fixes and PRs from a Slack mention",
    description:
      "A coding agent you mention in Slack or on GitHub that investigates bugs, reviews changes, and opens pull requests from an isolated Vercel Sandbox, with GitHub tokens scoped to one repository per command.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-coding-agent-template",
    category: "Collaboration",
    model: "anthropic/claude-opus-5.5",
    integrations: ["Slack", "GitHub", "Vercel"],
    source: "Vercel Templates",
    github: {
      owner: "vercel",
      repo: "eve",
      ref: "main",
      pathPrefix: "apps/templates/eve-coding-agent-template",
    },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/channels/github.ts",
      "agent/extensions/code.ts",
      "agent/extensions/git.ts",
      "agent/hooks/reset-github-egress.ts",
      "agent/instructions.md",
      "agent/lib/github.ts",
      "agent/sandbox.ts",
    ],
    preview: {
      surface: "slack",
      agent: "coder",
      icon: "/templates/icons/coding-agent.svg",
      context: "eng",
      messages: [
        { from: "user", text: "@coder checkout 500s on empty carts, can you fix it?" },
        {
          from: "agent",
          text: "Found it: `pricing.ts` reads the first item of an empty cart. Opened [PR #482](https://github.com/acme/shop/pull/482) with a fix and a test.",
          attachment: {
            type: "link",
            site: "GitHub",
            title: "#482 Fix checkout crash on empty carts",
          },
        },
      ],
    },
  },
  {
    slug: "eve-data-analyst-template",
    title: "Data Analyst",
    setupPrompt:
      "Set up the eve data analyst template in my current workspace using https://github.com/vercel-labs/eve-data-analyst-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required database, Slack, and Vercel setup steps.",
    tagline: "Ask Postgres questions in Slack",
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
    preview: {
      surface: "slack",
      agent: "analyst",
      icon: "/templates/icons/data-analyst.svg",
      context: "data",
      messages: [
        { from: "user", text: "@analyst what was our MRR last month?" },
        {
          from: "agent",
          text: "$48.2K in September, up 6% from August.",
          attachment: {
            type: "chart",
            title: "MRR, last 12 months",
            values: [31.0, 32.4, 33.1, 34.8, 35.9, 37.2, 38.8, 40.1, 41.9, 43.6, 45.5, 48.2],
          },
        },
      ],
    },
  },
  {
    slug: "eve-contentful-agent-template",
    title: "Contentful Assistant",
    setupPrompt:
      "Set up the eve Contentful agent template in my current workspace using https://github.com/vercel-labs/eve-contentful-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required Contentful, Slack, and Vercel setup steps.",
    tagline: "Draft and edit Contentful from Slack",
    description:
      "A Slack-based Contentful assistant that searches, drafts, and edits entries, with approval before publishing content.",
    sourceHref: "https://github.com/vercel-labs/eve-contentful-agent-template/tree/main",
    category: "Collaboration",
    model: "anthropic/claude-opus-5.5-fast",
    integrations: ["Slack", "Contentful", "Vercel"],
    source: "Vercel Templates",
    github: { owner: "vercel-labs", repo: "eve-contentful-agent-template", ref: "main" },
    files: [
      "agent/agent.ts",
      "agent/channels/slack.ts",
      "agent/instructions.md",
      "agent/schedules/contentful-mirror-nightly.ts",
      "agent/skills/contentful_api.md",
      "agent/skills/search_content/SKILL.md",
      "agent/tools/run_contentful_query.ts",
      "agent/tools/update_contentful_fields.ts",
      "agent/tools/publish_contentful_entry.ts",
    ],
    preview: {
      surface: "slack",
      agent: "content-bot",
      icon: "/templates/icons/contentful.svg",
      context: "content",
      messages: [
        {
          from: "user",
          text: "@content-bot turn the outline in this thread into a blog post draft for the spring launch",
        },
        {
          from: "agent",
          text: "Drafted [Spring Launch Recap](https://app.contentful.com) in Contentful: 1,100 words, four sections, and a hero image. Publish it?",
          attachment: { type: "approval", approve: "Publish" },
        },
      ],
    },
  },
  {
    slug: "eve-vercel-drives-starter",
    title: "Team Knowledge Assistant",
    setupPrompt:
      "Set up the eve Vercel Drives starter in my current workspace using https://github.com/vercel-labs/eve-vercel-drives-starter as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about the Slack and Vercel setup steps.",
    tagline: "Search and add notes on a Vercel Drive",
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
    preview: {
      surface: "slack",
      agent: "drive-bot",
      icon: "/templates/icons/vercel-drives.svg",
      context: "team",
      messages: [
        { from: "user", text: "@drive-bot how much PTO do new hires get, and does it roll over?" },
        {
          from: "agent",
          text: "15 days in year one, accrued monthly, and up to 5 unused days roll over. From `handbook/time-off.md` on the [team Drive](https://drive.example.com/team).",
        },
      ],
    },
  },
  {
    slug: "eve-memory-agent-template",
    title: "Memory Agent",
    setupPrompt:
      "Set up the eve memory agent template in my current workspace using https://github.com/vercel-labs/eve-memory-agent-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required Slack and Vercel setup steps.",
    tagline: "A Slack assistant that remembers you",
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
    preview: {
      surface: "slack",
      agent: "eve-memory",
      icon: "/templates/icons/memory-agent.svg",
      context: "general",
      messages: [
        {
          from: "user",
          text: "@eve-memory keep your answers to me short, and skip the pleasantries",
        },
        {
          from: "agent",
          text: "Saved to your preferences. Short, direct answers from now on, in every channel and DM. Say “forget that” anytime to undo it.",
        },
      ],
    },
  },
  {
    slug: "eve-tanstack-start-template",
    title: "TanStack Start Chat",
    setupPrompt:
      "Set up the eve TanStack Start template in my current workspace using https://github.com/vercel-labs/eve-tanstack-start-template as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required password and deployment setup steps.",
    tagline: "Generative UI chat on TanStack Start",
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
    preview: {
      surface: "web",
      context: "chat.example.com",
      messages: [
        {
          from: "user",
          text: "Walk me through making sourdough bread at home",
        },
        {
          from: "agent",
          tools: ["render_ui"],
          text: "Want a shopping list for everything you'll need?",
        },
        { from: "user", text: "Yes please" },
        {
          from: "agent",
          tools: ["render_ui"],
          text: "Want me to scale it up for two loaves?",
        },
      ],
    },
  },
  {
    slug: "eve-software-factory-template",
    title: "Software Factory",
    featured: true,
    setupPrompt:
      "I want to build a software factory with the eve framework, using the Foreman template. Read the setup instructions at https://ask-foreman.dev/docs/getting-started and follow them. They cover deploying the template, connecting GitHub and Linear, running it locally, and how the pipeline works overall.",
    tagline: "GitHub and Linear tasks to reviewed PRs",
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
    preview: {
      surface: "github",
      agent: "foreman",
      icon: "/templates/icons/foreman.png",
      thread: { kind: "issue", number: 471, title: "Checkout returns 500 on empty carts" },
      messages: [
        {
          from: "agent",
          text: "Draft PR #483 is ready. It guards empty carts in `pricing.ts` and adds a regression test.",
        },
        {
          from: "agent",
          text: "Review passed: the new test fails on `main` and passes on the branch, and your checks are green. Mark it ready when you are.",
        },
      ],
    },
  },
  {
    slug: "marketing-team-eve-template",
    title: "Marketing Team Coordinator",
    setupPrompt:
      "I want to build a team of marketing agents with the eve framework, using the marketing team template. Read the setup instructions at https://agent-resources.dev/marketing-team-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    tagline: "A team of marketing agents in Slack",
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
    preview: {
      surface: "slack",
      agent: "marketing",
      icon: "/templates/icons/marketing-team.svg",
      context: "launch",
      messages: [
        { from: "user", text: "@marketing can you draft Thursday's launch posts?" },
        {
          from: "agent",
          text: "On it. Briefing the social media coordinator.",
          attachment: {
            type: "tasks",
            tasks: [{ title: "Social media coordinator", output: "Done in 42s" }],
          },
        },
        {
          from: "agent",
          text: "Done. Three drafts are waiting in [Typefully](https://typefully.com).",
        },
      ],
    },
  },
  {
    slug: "openinstinct-eve-template",
    title: "iMessage Agent as a Service",
    setupPrompt:
      "I want to build a multi-tenant iMessage agent service with eve, using OpenInstinct at https://github.com/Merit-Systems/OpenInstinct. Read its README and follow its deployment instructions. Preserve the existing project if my workspace is not empty. Explain the required Linq, Kernel, database, storage, and model provider setup, and distinguish optional account integrations from required services. Call out the repository's warning that the application is not intended for production use.",
    tagline: "Multi-tenant iMessage agents on Linq",
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
    preview: {
      surface: "imessage",
      agent: "OpenInstinct",
      icon: "/templates/icons/openinstinct.svg",
      messages: [
        { from: "user", text: "Can you grab 2 tickets for Dune tonight, around 7?" },
        {
          from: "agent",
          text: "Found a 7:15 showing, 2 seats in row G for $38. Book with Link?",
        },
        { from: "user", text: "yes please" },
      ],
    },
  },
  {
    slug: "kody-eve-template",
    title: "GitHub Project Maintainer",
    setupPrompt:
      "I want to build a GitHub maintainer agent with the eve framework, using the Kody template. Read the setup instructions at https://agent-resources.dev/kody-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    tagline: "A GitHub maintainer that works by email",
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
      "agent/extensions/github.ts",
      "agent/instructions.ts",
      "agent/schedules/weekly-digest.ts",
      "agent/skills/triaging-issues/SKILL.md",
      "agent/subagents/researcher/agent.ts",
    ],
    preview: {
      surface: "github",
      agent: "kody",
      thread: { kind: "pull", number: 482, title: "Show currency on the order summary" },
      review: { line: 42, code: "const currency = items[0].currency;" },
      messages: [
        { from: "user", text: "@kody is this safe when the cart is empty?" },
        { from: "agent", text: "No, `items[0]` throws on an empty cart. Same crash as #471." },
        { from: "user", text: "@kody can you track a fix in Linear?" },
        {
          from: "agent",
          text: "Created [ENG-214](https://linear.app) for it and linked it from #471.",
        },
      ],
    },
  },
  {
    slug: "typefully-eve-template",
    title: "Social Media Manager",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Typefully social media agent template. Read the setup instructions at https://agent-resources.dev/typefully-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    tagline: "Draft and queue social posts from Slack",
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
      "agent/subagents/draft-reviewer/agent.ts",
      "agent/subagents/web-researcher/agent.ts",
      "agent/tools/lint_against_style.ts",
    ],
    preview: {
      surface: "slack",
      agent: "social",
      icon: "/templates/icons/typefully.svg",
      context: "social",
      messages: [
        { from: "user", text: "@social turn the v2 launch brief in Notion into an X thread" },
        {
          from: "agent",
          text: "Drafted a 5-post thread in [Typefully](https://typefully.com) with the launch video on post 1, queued for Thursday 9 AM. Want a LinkedIn version too?",
        },
      ],
    },
  },
  {
    slug: "eve-sre-agent-template",
    title: "Incident Investigation Assistant",
    setupPrompt:
      "I want to set up sre, an incident response agent built with the eve framework. Read the setup instructions at https://github.com/vercel-labs/eve-sre-agent-template/blob/main/docs/setup-for-agents.md and follow them. They cover creating and linking the Vercel project, connecting Slack, GitHub, Datadog, and Vercel, deploying the agent, and verifying it in Slack.",
    tagline: "Investigate alerts with live evidence",
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
    preview: {
      surface: "slack",
      agent: "sre",
      icon: "/templates/icons/sre.svg",
      context: "incidents",
      messages: [
        { from: "user", text: "@sre checkout 5xx spiked at 14:02, what happened?" },
        {
          from: "agent",
          text: "The 14:01 deploy's new `payments-client` is [timing out on Stripe](https://app.datadoghq.com/dashboard/checkout). Want me to roll back?",
          attachment: { type: "link", site: "Datadog", title: "checkout: 5xx errors by version" },
        },
      ],
    },
  },
  {
    slug: "sanity-copilot-eve-template",
    title: "Sanity Content Assistant",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Sanity copilot template. Read the setup instructions at https://agent-resources.dev/sanity-copilot-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    tagline: "Query and edit Sanity content from Slack",
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
    preview: {
      surface: "slack",
      agent: "sanity",
      icon: "/templates/icons/sanity.svg",
      context: "content",
      messages: [
        { from: "user", text: "@sanity which blog posts are missing an SEO description?" },
        {
          from: "agent",
          text: "12 published posts have no `seo.description`, mostly from the 2024 archive. Want me to draft them in a new release for review?",
        },
      ],
    },
  },
  {
    slug: "eve-design-template",
    title: "Company Design Assistant",
    setupPrompt:
      "Set up the eve design agent template in my current workspace using https://github.com/vercel-labs/eve-design-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README and BOOTSTRAP.md to configure it. Preserve the existing project if the workspace is not empty, tell me about any required environment variables or manual setup steps, and do not approve or publish the design corpus for me.",
    tagline: "Your design guidance, answered in Slack",
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
    preview: {
      surface: "slack",
      agent: "design",
      icon: "/templates/icons/design.svg",
      context: "design",
      messages: [
        {
          from: "user",
          text: "@design what's our minimum tap target on mobile? Asking for the new nav",
        },
        {
          from: "agent",
          text: "44×44px, per the [interaction guidelines](https://design.example.com/interaction). Pad small icons instead of scaling them up, and keep 8px between targets.",
        },
      ],
    },
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
