export type TemplateCategory = "Chat" | "Collaboration" | "Example" | "Marketing";
import { templateSourceFiles } from "./sources";

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

export interface TemplateFile {
  contents: string;
  language: "markdown" | "typescript";
  relativePath: string;
}

export interface TemplateEntry {
  category: TemplateCategory;
  description: string;
  files: TemplateFile[];
  integrations: TemplateIntegration[];
  model: string;
  slug: string;
  source: TemplateSource;
  sourceHref: string;
  sourceRevision: string;
  setupPrompt: string;
  title: string;
}

export const templateEntries: TemplateEntry[] = [
  {
    slug: "eve-chat-template",
    title: "Chat",
    setupPrompt:
      "Set up the eve chat template in my current workspace using https://github.com/vercel-labs/eve-chat-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    sourceHref: "https://github.com/vercel-labs/eve-chat-template/tree/main",
    sourceRevision: "f7c164ac8901e5400f6e4ef00eead67ee71cd5d4",
    category: "Chat",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Web chat", "Slack", "Linear", "Notion", "Sentry"],
    source: "Vercel Templates",
    files: templateSourceFiles["eve-chat-template"],
  },
  {
    slug: "eve-design-template",
    title: "Design",
    setupPrompt:
      "Set up the eve design agent template in my current workspace using https://github.com/vercel-labs/eve-design-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README and BOOTSTRAP.md to configure it. Preserve the existing project if the workspace is not empty, tell me about any required environment variables or manual setup steps, and do not approve or publish the design corpus for me.",
    description:
      "A Slack design collaborator that answers from a reviewed, versioned corpus of your organization's approved design guidance.",
    sourceHref: "https://github.com/vercel-labs/eve-design-template/tree/main",
    sourceRevision: "7f8e5a62b02cb3407e063fc98c56c83dabbd95f4",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-4.6",
    integrations: ["Slack"],
    source: "Vercel Templates",
    files: templateSourceFiles["eve-design-template"],
  },
  {
    slug: "eve-slack-agent",
    title: "Slack",
    setupPrompt:
      "Set up the eve Slack agent template in my current workspace using https://github.com/vercel-labs/eve-slack-agent-template/tree/main as the source. Copy the project files, install its dependencies, and follow the repository README to configure it. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    sourceHref: "https://github.com/vercel-labs/eve-slack-agent-template/tree/main",
    sourceRevision: "bb35e1fb0159926c625d356d0b43ad618e11b44c",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack"],
    source: "Vercel Templates",
    files: templateSourceFiles["eve-slack-agent"],
  },
  {
    slug: "kody",
    title: "GitHub",
    setupPrompt:
      "I want to build a GitHub maintainer agent with the eve framework, using the Kody template. Read the setup instructions at https://agent-resources.dev/kody-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "Kody, a personal GitHub maintainer agent: emails you a weekly digest of open issues, acts on your replies, summarizes new pull requests, and works the issues you delegate in Linear.",
    sourceHref: "https://github.com/vercel-labs/kody-eve-template/tree/main",
    sourceRevision: "8427e3c7e88a6a449dd7c79c601619ac37cf18e1",
    category: "Collaboration",
    model: "anthropic/claude-fable-5",
    integrations: ["GitHub", "Linear", "Resend"],
    source: "Vercel Templates",
    files: templateSourceFiles.kody,
  },
  {
    slug: "marketing-team-eve-template",
    title: "Marketing team",
    setupPrompt:
      "I want to build a team of marketing agents with the eve framework, using the marketing team template. Read the setup instructions at https://agent-resources.dev/marketing-team-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A team of marketing agents: a lead routes work to specialists for positioning, long-form content, social, SEO, and email, publishing through Notion, Typefully, and Resend.",
    sourceHref: "https://github.com/vercel-labs/marketing-team-eve-template/tree/main",
    sourceRevision: "9a881661bd5b0652469467f00eadbd41e9f2c786",
    category: "Marketing",
    model: "anthropic/claude-opus-5",
    integrations: ["Web chat", "Slack", "Notion", "Resend", "Typefully"],
    source: "Vercel Templates",
    files: templateSourceFiles["marketing-team-eve-template"],
  },
  {
    slug: "sanity-copilot",
    title: "Sanity",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Sanity copilot template. Read the setup instructions at https://agent-resources.dev/sanity-copilot-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A Slack copilot for your Sanity project: query and edit content with GROQ, shape schemas, manage releases, and draft long-form pieces into Notion.",
    sourceHref: "https://github.com/vercel-labs/sanity-copilot-eve-template/tree/main",
    sourceRevision: "f076b80e2bb3a2ccae3dc1cfe4886d5ac88c338b",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack", "Sanity", "Notion"],
    source: "Vercel Templates",
    files: templateSourceFiles["sanity-copilot"],
  },
  {
    slug: "typefully",
    title: "Typefully",
    setupPrompt:
      "I want to build a Slack agent with the eve framework, using the Typefully social media agent template. Read the setup instructions at https://agent-resources.dev/typefully-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.",
    description:
      "A Slack agent that runs your social presence through Typefully: draft posts and threads for X, LinkedIn, Threads, Bluesky, and Mastodon, manage the publishing queue, and get a weekly analytics digest.",
    sourceHref: "https://github.com/vercel-labs/typefully-eve-template/tree/main",
    sourceRevision: "3627b2282a9ebfa1badd987f2b3a0c337219575f",
    category: "Collaboration",
    model: "anthropic/claude-sonnet-5",
    integrations: ["Slack", "Typefully", "Notion"],
    source: "Vercel Templates",
    files: templateSourceFiles.typefully,
  },
  {
    slug: "weather-agent-fixture",
    title: "Weather",
    setupPrompt:
      "Set up the eve weather agent in my current workspace using https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent as the source. Copy that fixture into a standalone project, install its dependencies, and make any minimal changes needed to run it outside the eve monorepo. Preserve the existing project if the workspace is not empty, and tell me about any required environment variables or manual setup steps.",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
    sourceRevision: "71d57185233d2bd9ff31fe0cd21915df7afa6e2e",
    category: "Example",
    model: "anthropic/claude-sonnet-5",
    integrations: ["HTTP API"],
    source: "GitHub",
    files: templateSourceFiles["weather-agent-fixture"],
  },
];

export const getTemplateEntry = (slug: string): TemplateEntry | undefined =>
  templateEntries.find((entry) => entry.slug === slug);
