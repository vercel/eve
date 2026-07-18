import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { linearLogo, notionLogo, sentryLogo, slackLogo, webLogo } from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  "Web chat": webLogo,
};
