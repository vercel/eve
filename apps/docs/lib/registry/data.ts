export type RegistryCategory = "Chat" | "Collaboration" | "Example";
import { registrySourceFiles } from "./sources";

export type RegistryIntegration =
  | "HTTP API"
  | "Linear"
  | "Notion"
  | "Sentry"
  | "Slack"
  | "Web chat";
export type RegistrySource = "GitHub" | "Vercel Templates";

export interface RegistryFile {
  contents: string;
  language: "markdown" | "typescript";
  relativePath: string;
}

export interface RegistryEntry {
  bootstrapCommand: string;
  category: RegistryCategory;
  deployHref: string;
  description: string;
  files: RegistryFile[];
  integrations: RegistryIntegration[];
  model: string;
  slug: string;
  source: RegistrySource;
  sourceHref: string;
  sourceRevision: string;
  title: string;
}

export const registryEntries: RegistryEntry[] = [
  {
    slug: "eve-chat-template",
    title: "Chat",
    bootstrapCommand: "npx eve@latest init my-agent --template eve-chat-template",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    deployHref: "https://vercel.com/templates/eve/eve-chat-template",
    sourceHref:
      "https://github.com/vercel-labs/eve-chat-template/tree/80625bd00858cfd21abc3249ee9e446a1629afe3",
    sourceRevision: "80625bd00858cfd21abc3249ee9e446a1629afe3",
    category: "Chat",
    model: "anthropic/claude-haiku-4.5",
    integrations: ["Web chat", "Slack", "Linear", "Notion", "Sentry"],
    source: "Vercel Templates",
    files: registrySourceFiles["eve-chat-template"],
  },
  {
    slug: "eve-slack-agent",
    title: "Slack",
    bootstrapCommand: "npx eve@latest init my-agent --template eve-slack-agent",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    deployHref: "https://vercel.com/templates/eve/eve-slack-agent",
    sourceHref:
      "https://github.com/vercel-labs/eve-slack-agent-template/tree/f7286e71edc2e230cb98519e6d9fd1a23d6cd8e8",
    sourceRevision: "f7286e71edc2e230cb98519e6d9fd1a23d6cd8e8",
    category: "Collaboration",
    model: "anthropic/claude-haiku-4.5",
    integrations: ["Slack"],
    source: "Vercel Templates",
    files: registrySourceFiles["eve-slack-agent"],
  },
  {
    slug: "weather-agent-fixture",
    title: "Weather",
    bootstrapCommand: "npx eve@latest init weather-agent --template weather-agent",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    deployHref:
      "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve&root-directory=apps%2Ffixtures%2Fweather-agent",
    sourceHref:
      "https://github.com/vercel/eve/tree/c1b6ad3e485f2d15a25bdb5636209aa1367a3124/apps/fixtures/weather-agent",
    sourceRevision: "c1b6ad3e485f2d15a25bdb5636209aa1367a3124",
    category: "Example",
    model: "anthropic/claude-sonnet-5",
    integrations: ["HTTP API"],
    source: "GitHub",
    files: registrySourceFiles["weather-agent-fixture"],
  },
];

export const getRegistryEntry = (slug: string): RegistryEntry | undefined =>
  registryEntries.find((entry) => entry.slug === slug);
