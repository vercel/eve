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
import { templatePath } from "@/lib/geistdocs/canonical";
import { logos } from "@/lib/integrations/logos";
import { templateManifest } from "@/lib/templates/manifest";

const capabilityIcons = {
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
} satisfies Record<string, ReactNode>;

const iconClassName = "size-4 shrink-0";

const channels = {
  discord: {
    label: "Discord",
    logo: logos.discord({ "aria-hidden": true, className: iconClassName }),
  },
  github: {
    label: "GitHub",
    logo: logos.github({ "aria-hidden": true, className: iconClassName }),
  },
  imessage: { label: "iMessage", logo: <SiImessage aria-hidden className={iconClassName} /> },
  linear: {
    label: "Linear",
    logo: logos.linear({ "aria-hidden": true, className: iconClassName }),
  },
  slack: { label: "Slack", logo: logos.slack({ "aria-hidden": true, className: iconClassName }) },
  teams: {
    label: "Microsoft Teams",
    logo: logos.teams({ "aria-hidden": true, className: iconClassName }),
  },
  telegram: {
    label: "Telegram",
    logo: logos.telegram({ "aria-hidden": true, className: iconClassName }),
  },
  web: { label: "Web", logo: logos.web({ "aria-hidden": true, className: iconClassName }) },
  whatsapp: {
    label: "WhatsApp",
    logo: logos.whatsapp({ "aria-hidden": true, className: iconClassName }),
  },
} satisfies Record<string, { label: string; logo: ReactNode }>;

const cardClassName =
  "group flex h-full min-w-0 flex-col rounded-xl border border-gray-alpha-400 bg-background-100 p-4 no-underline transition-colors hover:border-gray-alpha-600 sm:p-5";

export function UseCaseSummaries({ children }: { children: ReactNode }): JSX.Element {
  return <div className="not-prose my-8 grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>;
}

/** Links to a use case section and lists the channels it usually runs in. */
export function UseCaseSummary({
  audience,
  title,
  href,
  channels: channelIds,
  children,
}: {
  audience: string;
  title: string;
  href: string;
  channels: (keyof typeof channels)[];
  children: ReactNode;
}): JSX.Element {
  return (
    <a className={`${cardClassName} gap-5`} href={href}>
      <div className="flex flex-col gap-1">
        <span className="text-copy-13 text-gray-900">{audience}</span>
        <span className="flex items-center justify-between gap-2 text-gray-1000 text-heading-20">
          {title}
          <IconChevronRightSmall
            className="shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-1000"
            size={16}
          />
        </span>
        <div className="text-copy-14 text-gray-900">{children}</div>
      </div>
      <ul aria-label="Common channels" className="mt-auto flex list-none flex-wrap gap-2 p-0">
        {channelIds.map((id) => (
          <li
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-copy-13 text-gray-1000 material-small"
            key={id}
          >
            <span className="flex text-gray-900 grayscale">{channels[id].logo}</span>
            {channels[id].label}
          </li>
        ))}
      </ul>
    </a>
  );
}

export function TemplateCards({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="not-prose my-6 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

/** Opens a template from the gallery, showing its integrations. */
export function TemplateCard({
  title,
  template: slug,
  label,
  children,
}: {
  title: string;
  template: string;
  /** Shorter link label for templates whose gallery title is long. */
  label?: string;
  children: ReactNode;
}): JSX.Element {
  const template = templateManifest.find((entry) => entry.slug === slug);
  if (!template) throw new Error(`Unknown template "${slug}" in a TemplateCard.`);
  return (
    <Link className={`${cardClassName} gap-2`} href={templatePath(slug)} prefetch={true}>
      <span className="flex items-start justify-between gap-2 text-gray-1000 text-heading-16">
        {title}
        <IconArrowUpRightSmall
          className="mt-0.5 shrink-0 text-gray-700 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-gray-1000"
          size={16}
        />
      </span>
      <div className="text-copy-14 text-gray-900">{children}</div>
      <span className="mt-auto flex flex-col gap-2 pt-3">
        <span className="flex items-center gap-1.5 text-gray-900 grayscale">
          {template.integrations.map((integration) => {
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
              <Icon aria-label={integration} className="size-3.5" key={integration} role="img" />
            );
          })}
        </span>
        <span className="text-copy-13 text-gray-900">{label ?? template.title} template</span>
      </span>
    </Link>
  );
}

export function Capabilities({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ul className="not-prose my-6 min-w-0 list-none border-gray-alpha-400 border-y p-0">
      {children}
    </ul>
  );
}

/** One capability row: what the use case needs, how eve covers it, and the docs page. */
export function Capability({
  icon,
  title,
  href,
  link,
  children,
}: {
  icon: keyof typeof capabilityIcons;
  title: string;
  href: string;
  link: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <li className="flex min-w-0 gap-4 border-gray-alpha-400 border-b py-5 last:border-b-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md text-gray-1000 material-small">
        {capabilityIcons[icon]}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 pt-1">
        <span className="text-gray-1000 text-heading-16">{title}</span>
        <div className="max-w-[60ch] text-copy-14 text-gray-900">{children}</div>
        <Link
          className="mt-1 flex w-fit items-center gap-0.5 font-medium text-copy-14 text-gray-1000 no-underline hover:underline"
          href={href}
          prefetch={true}
        >
          {link}
          <IconChevronRightSmall className="text-gray-900" size={16} />
        </Link>
      </div>
    </li>
  );
}
