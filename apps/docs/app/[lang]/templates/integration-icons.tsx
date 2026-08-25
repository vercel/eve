import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  datadogLogo,
  githubLogo,
  linearLogo,
  notionLogo,
  resendLogo,
  sanityLogo,
  sentryLogo,
  slackLogo,
  typefullyLogo,
  vercelLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  Datadog: datadogLogo,
  GitHub: githubLogo,
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Resend: resendLogo,
  Sanity: sanityLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  Typefully: typefullyLogo,
  Vercel: vercelLogo,
  "Web chat": webLogo,
};
