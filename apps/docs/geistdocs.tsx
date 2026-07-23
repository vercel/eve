import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import type { GeistdocsGithubConfig } from "@vercel/geistdocs/config";

export const Logo = () => <LogoEve height={15} />;

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
  {
    label: "GitHub",
    href: `https://github.com/${github.owner}/${github.repo}/`,
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
      "A filesystem-first framework for building durable agents on Vercel with markdown instructions, TypeScript tools, and built-in runtime primitives.",
    category: "Agent framework",
    audience: ["developers building AI agents", "Vercel users"],
    useCases: [
      "Create durable agents with filesystem conventions",
      "Add channels, tools, skills, sandboxes, hooks, and schedules",
      "Deploy agent workloads on Vercel",
    ],
  },
  instructions: [
    "To create or extend an eve agent for the user, start from the Getting Started guide — get it as Markdown from /llms.mdx/getting-started (or via /llms.txt).",
    "Ask the user only for genuine decisions (name, model, channels, provider, deploy) and for browser/OAuth steps (vercel login, vercel link, vercel connect create slack); automate everything else.",
    "Verify setup with `eve info --json` and `eve channels list --json` before reporting success.",
    "Use /sitemap.md to identify the most relevant documentation pages before answering broad questions.",
    "Use /llms.txt when you need the complete documentation corpus as Markdown context.",
    "Fetch individual documentation pages with a .md or .mdx extension for focused page-level context.",
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

export const translations = {
  en: {
    displayName: "English",
  },
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = "agent-framework";
