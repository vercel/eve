export type TemplateIntegration =
  | "GitHub"
  | "Linear"
  | "Linq"
  | "MotherDuck"
  | "Notion"
  | "Resend"
  | "Slack"
  | "Stripe Link"
  | "Typefully"
  | "Vercel"
  | "Voice"
  | "Web chat"
  | "dbt";

interface TemplateManifestEntry {
  slug: string;
  title: string;
  sourceHref: string;
  integrations: TemplateIntegration[];
}

export const templateManifest: TemplateManifestEntry[] = [
  {
    slug: "eve-chat-template",
    title: "Web Chat Agent",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-chat-template",
    integrations: ["Web chat", "Slack"],
  },
  {
    slug: "eve-voice-template",
    title: "Voice Agent",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-voice-template",
    integrations: ["Voice", "Web chat"],
  },
  {
    slug: "eve-company-brain-template",
    title: "Company Brain",
    sourceHref: "https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template",
    integrations: ["Slack", "dbt", "MotherDuck"],
  },
  {
    slug: "eve-software-factory-template",
    title: "Software Factory",
    sourceHref: "https://github.com/vercel-labs/eve-software-factory-template/tree/main",
    integrations: ["GitHub", "Linear"],
  },
  {
    slug: "marketing-team-eve-template",
    title: "Marketing Team Coordinator",
    sourceHref: "https://github.com/vercel-labs/marketing-team-eve-template/tree/main",
    integrations: ["Web chat", "Slack", "Notion", "Resend", "Typefully"],
  },
  {
    slug: "openinstinct-eve-template",
    title: "iMessage Agent as a Service",
    sourceHref: "https://github.com/Merit-Systems/OpenInstinct/tree/main",
    integrations: ["Linq", "Stripe Link", "Vercel"],
  },
];
