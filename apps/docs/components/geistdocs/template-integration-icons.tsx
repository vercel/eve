import type { ComponentType, SVGProps } from "react";
import {
  dbtLogo,
  githubLogo,
  linearLogo,
  linkLogo,
  linqLogo,
  motherduckLogo,
  notionLogo,
  resendLogo,
  slackLogo,
  typefullyLogo,
  vercelLogo,
  voiceLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/manifest";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  dbt: dbtLogo,
  GitHub: githubLogo,
  Linear: linearLogo,
  Linq: linqLogo,
  MotherDuck: motherduckLogo,
  Notion: notionLogo,
  Resend: resendLogo,
  Slack: slackLogo,
  "Stripe Link": linkLogo,
  Typefully: typefullyLogo,
  Vercel: vercelLogo,
  Voice: voiceLogo,
  "Web chat": webLogo,
};
