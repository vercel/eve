export interface Resource {
  description: string;
  href: string;
  title: string;
}

export const resources: Resource[] = [
  {
    title: "eve Chat Template",
    description:
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, Neon, and Upstash Redis.",
    href: "https://vercel.com/templates/eve/eve-chat-template",
  },
  {
    title: "eve Slack Agent",
    description:
      "A Slack agent template with webhook handling, Vercel Connect, a starter agent, and an example tool ready to deploy on Vercel.",
    href: "https://vercel.com/templates/eve/eve-slack-agent",
  },
];
