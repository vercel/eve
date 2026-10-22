import { SiImessage } from "@icons-pack/react-simple-icons";
import {
  IconArchive,
  IconArrowUpRightSmall,
  IconBox,
  IconCheck,
  IconChevronRightSmall,
  IconClock,
  IconLinked,
  IconLogs,
  IconMessage,
  IconSandbox,
  IconShieldCheck,
  IconSparkles,
  IconToggleOn,
  IconUser,
  IconWorkflow,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { integrationIcons } from "@/app/[lang]/templates/integration-icons";
import { logos } from "@/lib/integrations/logos";
import {
  type CapabilityIcon,
  type ChannelLogo,
  resolveTemplateLink,
  type UseCaseId,
  useCases,
} from "@/lib/geistdocs/use-cases";
import { cn } from "@/lib/utils";

const capabilityIcons: Record<CapabilityIcon, ReactNode> = {
  approval: <IconUser size={16} />,
  channels: <IconMessage size={16} />,
  connections: <IconLinked size={16} />,
  durability: <IconWorkflow size={16} />,
  dynamic: <IconToggleOn size={16} />,
  evals: <IconCheck size={16} />,
  identity: <IconShieldCheck size={16} />,
  memory: <IconArchive size={16} />,
  models: <IconSparkles size={16} />,
  observability: <IconLogs size={16} />,
  sandbox: <IconSandbox size={16} />,
  schedules: <IconClock size={16} />,
  tenancy: <IconBox size={16} />,
  tools: <IconWrench size={16} />,
};

const iconClassName = "size-4 shrink-0";

const channelLogos: Record<ChannelLogo, ReactNode> = {
  discord: logos.discord({ "aria-hidden": true, className: iconClassName }),
  github: logos.github({ "aria-hidden": true, className: iconClassName }),
  imessage: <SiImessage aria-hidden className={iconClassName} />,
  linear: logos.linear({ "aria-hidden": true, className: iconClassName }),
  slack: logos.slack({ "aria-hidden": true, className: iconClassName }),
  teams: logos.teams({ "aria-hidden": true, className: iconClassName }),
  telegram: logos.telegram({ "aria-hidden": true, className: iconClassName }),
  web: logos.web({ "aria-hidden": true, className: iconClassName }),
  whatsapp: logos.whatsapp({ "aria-hidden": true, className: iconClassName }),
};

/** Side-by-side summary of the two use cases and the channels each one usually lives in. */
export function UseCaseOverview(): JSX.Element {
  return (
    <figure
      aria-label="The two most common eve use cases"
      className="not-prose my-8 grid min-w-0 gap-4 sm:grid-cols-2"
    >
      {Object.values(useCases).map(({ anchor, audience, channels, summary, title }) => (
        <a
          className="group flex min-w-0 flex-col gap-5 rounded-xl border border-gray-alpha-400 bg-background-100 p-4 no-underline transition-colors hover:border-gray-alpha-600 sm:p-5"
          href={`#${anchor}`}
          key={anchor}
        >
          <div className="flex flex-col gap-1">
            <span className="text-copy-13 text-gray-900">{audience}</span>
            <span className="flex items-center justify-between gap-2 text-gray-1000 text-heading-20">
              {title}
              <IconChevronRightSmall
                className="shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-1000"
                size={16}
              />
            </span>
            <span className="text-copy-14 text-gray-900">{summary}</span>
          </div>
          <ul aria-label="Common channels" className="mt-auto flex list-none flex-wrap gap-2 p-0">
            {channels.map((channel) => (
              <li
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-copy-13 text-gray-1000 material-small"
                key={channel.logo}
              >
                <span className="flex text-gray-900 grayscale">{channelLogos[channel.logo]}</span>
                {channel.label}
              </li>
            ))}
          </ul>
        </a>
      ))}
    </figure>
  );
}

/** Common patterns for one use case; each card opens its closest template. */
export function UseCasePatterns({ useCase }: { useCase: UseCaseId }): JSX.Element {
  const { patterns } = useCases[useCase];
  return (
    <ul
      className={cn(
        "not-prose my-6 grid min-w-0 list-none gap-4 p-0 sm:grid-cols-2",
        patterns.length > 2 && "lg:grid-cols-3",
      )}
    >
      {patterns.map((pattern) => {
        const link = resolveTemplateLink(pattern);
        return (
          <li className="min-w-0" key={pattern.title}>
            <Link
              className="group flex h-full flex-col gap-2 rounded-xl border border-gray-alpha-400 bg-background-100 p-4 no-underline transition-colors hover:border-gray-alpha-600 sm:p-5"
              href={link.href}
              prefetch={true}
            >
              <span className="flex items-start justify-between gap-2 text-gray-1000 text-heading-16">
                {pattern.title}
                <IconArrowUpRightSmall
                  className="mt-0.5 shrink-0 text-gray-700 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-gray-1000"
                  size={16}
                />
              </span>
              <span className="text-copy-14 text-gray-900">{pattern.description}</span>
              <span className="mt-auto flex flex-col gap-2 pt-3">
                <span className="flex items-center gap-1.5 text-gray-900 grayscale">
                  {link.template.integrations.map((integration) => {
                    // Linq delivers iMessage, and readers recognize the iMessage mark.
                    if (integration === "Linq") {
                      return (
                        <SiImessage
                          aria-label="iMessage"
                          className="size-3.5"
                          key={integration}
                          role="img"
                        />
                      );
                    }
                    const Icon = integrationIcons[integration];
                    return (
                      <Icon
                        aria-label={integration}
                        className="size-3.5"
                        key={integration}
                        role="img"
                      />
                    );
                  })}
                </span>
                <span className="text-copy-13 text-gray-900">{link.label}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Maps what a use case needs to the eve capability that provides it. */
export function UseCaseCapabilities({ useCase }: { useCase: UseCaseId }): JSX.Element {
  return (
    <ul className="not-prose my-6 min-w-0 list-none border-gray-alpha-400 border-y p-0">
      {useCases[useCase].capabilities.map((capability) => (
        <li
          className="flex min-w-0 gap-4 border-gray-alpha-400 border-b py-5 last:border-b-0"
          key={capability.need}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-1000 material-small">
            {capabilityIcons[capability.icon]}
          </span>
          <div className="flex min-w-0 flex-col gap-1.5 pt-1">
            <span className="text-gray-1000 text-heading-16">{capability.need}</span>
            <p className="max-w-[60ch] text-copy-14 text-gray-900">{capability.description}</p>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Link
                className="flex items-center gap-0.5 font-medium text-copy-14 text-gray-1000 no-underline hover:underline"
                href={capability.href}
                prefetch={true}
              >
                {capability.title}
                <IconChevronRightSmall className="text-gray-900" size={16} />
              </Link>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
