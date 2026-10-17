import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  contentfulLogo,
  datadogLogo,
  dbtLogo,
  githubLogo,
  linearLogo,
  linkLogo,
  linqLogo,
  muxLogo,
  motherduckLogo,
  notionLogo,
  postgresLogo,
  resendLogo,
  sanityLogo,
  sentryLogo,
  slackLogo,
  typefullyLogo,
  vercelLogo,
  voiceLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  Contentful: contentfulLogo,
  Datadog: datadogLogo,
  dbt: dbtLogo,
  GitHub: githubLogo,
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Linq: linqLogo,
  Mux: muxLogo,
  MotherDuck: motherduckLogo,
  Notion: notionLogo,
  Postgres: postgresLogo,
  Resend: resendLogo,
  Sanity: sanityLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  "Stripe Link": linkLogo,
  Typefully: typefullyLogo,
  Vercel: vercelLogo,
  Voice: voiceLogo,
  "Web chat": webLogo,
};
