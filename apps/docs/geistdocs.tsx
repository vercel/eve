import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import type { GeistdocsGithubConfig } from "@vercel/geistdocs/config";

export { translations } from "@/lib/geistdocs/languages";

export const Logo = () => <LogoEve />;

export const github: GeistdocsGithubConfig = {
  owner: "vercel",
  repo: "eve",
};

export const nav = [
  {
    label: "Docs",
    href: "/docs",
  },
  {
    label: "Integrations",
    href: "/integrations",
  },
  {
    label: "Templates",
    href: "/templates",
  },
];

export const suggestions = [
  "How do I create my first agent?",
  "What is the agent directory structure?",
  "How do channels work?",
  "How do I add tools to an agent?",
];

export const agent = {
  product: {
    name: "eve",
    description:
      "A filesystem-first, Apache-2.0 framework for building durable backend AI agents that run on Vercel or your own infrastructure. eve is currently in beta.",
    category: "Agent framework",
    audience: ["developers building AI agents", "teams running agents on any infrastructure"],
    useCases: [
      "Create durable agents with filesystem conventions",
      "Add channels, tools, skills, sandboxes, hooks, and schedules",
      "Deploy agent workloads on Vercel or self-host them as Node services",
    ],
  },
  instructions: [
    "To create or extend an eve agent for the user, start from the Getting Started guide — get it as Markdown from /llms.mdx/getting-started (or via /llms.txt).",
    "Ask the user only for genuine decisions (name, model, channels, provider, deploy) and for browser/OAuth steps (vercel login, vercel link, vercel connect create slack); automate everything else.",
    "Verify setup with `eve info --json` and `eve channels list --json` before reporting success.",
    "Use /llms.txt as a concise task-oriented index and /sitemap.md as the exhaustive page map.",
    "Use /llms-full.txt only when you need the complete documentation corpus for offline indexing or a large context window.",
    "Fetch individual docs or integration pages with a .md or .mdx extension for focused page-level context. Template pages are HTML discovery pages and do not expose this alternate Markdown route.",
    "Treat eve.dev as framework documentation, not a shared API, authorization server, MCP server, or A2A server. Every deployed eve app exposes its own /eve/v1 routes and authentication policy; external API, OpenAPI, and MCP URLs in the docs may describe third-party connections or examples.",
    "Do not assume API, authentication, OpenAPI, or MCP support unless it is listed in this file.",
  ],
};

export const title = "eve Documentation";

export const prompt =
  "You are a helpful assistant specializing in eve, a filesystem-first framework for building durable agents on Vercel. You help users understand how to build agents using markdown for instructions, TypeScript for tools, and the framework's built-in durability, governance, and observability features.";

// The help-eve agent (vercel/internal-agents/agents/help-eve) answers Ask AI.
// The deployment keeps the framework's pre-rename "ash" domain.
export const eveAgent = {
  url: "https://help-ash.vercel.sh",
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = "eve-docs";
