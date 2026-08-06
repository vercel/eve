import { BracesIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import {
  linearLogo,
  notionLogo,
  resendLogo,
  sentryLogo,
  slackLogo,
  typefullyLogo,
  webLogo,
} from "@/lib/integrations/logos";
import type { TemplateIntegration } from "@/lib/templates/data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  "HTTP API": BracesIcon,
  Linear: linearLogo,
  Notion: notionLogo,
  Resend: resendLogo,
  Sentry: sentryLogo,
  Slack: slackLogo,
  Typefully: typefullyLogo,
  "Web chat": webLogo,
};
