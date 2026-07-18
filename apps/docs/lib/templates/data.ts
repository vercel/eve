export type TemplateCategory = "Chat" | "Collaboration" | "Example";
import { templateSourceFiles } from "./sources";

export type TemplateIntegration =
  | "HTTP API"
  | "Linear"
  | "Notion"
  | "Sentry"
  | "Slack"
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
