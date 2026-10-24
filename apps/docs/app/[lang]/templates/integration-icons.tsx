import { BracesIcon } from "lucide-react";
import {
  Children,
  type ComponentType,
  cloneElement,
  isValidElement,
  type ReactElement,
  type SVGProps,
} from "react";
import {
  contentfulLogo,
  datadogLogo,
  discordLogo,
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

/** Draws a single-color logo in the text color. */
const inTextColor =
  (Logo: (props: SVGProps<SVGSVGElement>) => ReactElement<SVGProps<SVGSVGElement>>) =>
  (props: SVGProps<SVGSVGElement>) => {
    const svg = Logo(props);
    return cloneElement(
      svg,
      undefined,
      Children.map(svg.props.children, (child) =>
        isValidElement<SVGProps<SVGPathElement>>(child)
          ? cloneElement(child, { fill: "currentColor" })
          : child,
      ),
    );
  };

export const integrationIcons: Record<TemplateIntegration, IconComponent> = {
  Contentful: contentfulLogo,
  Datadog: datadogLogo,
  Discord: discordLogo,
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

/**
 * For icons drawn with `grayscale`. A mid-tone single brand color like
 * Discord's blurple turns a faded gray next to black-and-white logos, so
 * those logos use the text color instead.
 */
export const grayscaleIntegrationIcons: Record<TemplateIntegration, IconComponent> = {
  ...integrationIcons,
  Discord: inTextColor(discordLogo),
};
