import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  githubLogo,
  linearLogo,
  notionLogo,
  resendLogo,
  sanityLogo,
  sentryLogo,
  slackLogo,
  typefullyLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  GitHub: githubLogo,
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Resend: resendLogo,
  Sanity: sanityLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  Typefully: typefullyLogo,
  "Web chat": webLogo,
};
