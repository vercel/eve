export type ResourceKind = "Community" | "Example" | "Guide" | "Reference" | "Template";

export interface Resource {
  description: string;
  href: string;
  kind: ResourceKind;
  title: string;
}

export const resources: Resource[] = [
  {
    kind: "Guide",
    title: "Build your first agent",
    description:
      "Follow the tutorial from a first agent through warehouse tools, spend approval, and a deployable chat UI.",
    href: "/docs/tutorial/first-agent",
  },
  {
    kind: "Guide",
    title: "Frontend guides",
    description:
      "Use React, Vue, Svelte, Next.js, Nuxt, or SvelteKit helpers to put a durable eve session behind your own UI.",
    href: "/docs/guides/frontend/overview",
  },
  {
    kind: "Guide",
    title: "TypeScript client",
    description:
      "Drive the default HTTP channel from scripts, tests, backend jobs, or custom server-side integrations.",
    href: "/docs/guides/client/overview",
  },
  {
    kind: "Template",
    title: "eve Chat Template",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    href: "https://vercel.com/templates/eve/eve-chat-template",
  },
  {
    kind: "Template",
    title: "eve Slack Agent",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    href: "https://vercel.com/templates/eve/eve-slack-agent",
  },
  {
    kind: "Example",
    title: "Weather Agent Fixture",
    description:
      "A small representative eve app with agent config, instructions, a typed weather tool, and a markdown skill.",
    href: "https://github.com/vercel/eve/tree/main/apps/fixtures/weather-agent",
  },
  {
    kind: "Reference",
    title: "eve Knowledge Base",
    description:
      "Vercel's eve hub with getting-started guides, build guides, templates, docs, integrations, and community links.",
    href: "https://vercel.com/kb/eve",
  },
];
