"use client";

import { SiDocker, SiPostgresql, SiSnowflake } from "@icons-pack/react-simple-icons";
import {
  IconArrowUpRightSmall,
  IconLinked,
  IconMessage,
  IconOpenai,
  IconSandbox,
  IconSparkles,
  IconWorkflow,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import { IconArrowUpRight } from "@vercel/geistdocs/assets/icons/icon-arrow-up-right";
import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import { LogoIconVercel } from "@vercel/geistdocs/assets/logos/logo-icon-vercel";
import { Switch } from "@vercel/geistdocs/components/switch";
import Link from "next/link";
import { type ComponentType, type JSX, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { GradientBorder } from "./gradient-border";

type Mode = "managed" | "self-hosted";

type LogoComponent = ComponentType<{
  size?: number;
  color?: string;
  className?: string;
}>;

interface Backend {
  label: string;
  Logo: LogoComponent;
}

interface Primitive {
  icon: ReactNode;
  title: string;
  /** Overrides `title` per mode (e.g. the SDK only exists on managed infra). */
  titleByMode?: Record<Mode, string>;
  description: string;
  href?: string;
  /** Drop the link in self-hosted mode (the linked product is Vercel-only). */
  managedOnlyHref?: boolean;
  /** Concrete backend shown inside the card, swapped by the managed/self-hosted toggle. */
  backend?: Record<Mode, Backend>;
}

const RUNTIME_ITEMS: Primitive[] = [
  {
    icon: <IconSparkles className="mt-0.5 shrink-0 text-gray-1000" size={18} />,
    title: "AI SDK",
    description: "Model calls, streaming",
    href: "https://ai-sdk.dev/",
    backend: {
      managed: { label: "AI Gateway", Logo: LogoIconVercel },
      "self-hosted": { label: "GPT-5.4 API", Logo: IconOpenai },
    },
  },
  {
    icon: <IconSandbox className="mt-0.5 shrink-0 text-gray-1000" size={18} />,
    title: "Sandbox SDK",
    titleByMode: { managed: "Vercel Sandbox SDK", "self-hosted": "Sandbox" },
    description: "Isolated execution",
    href: "https://vercel.com/docs/sandbox/sdk-reference",
    managedOnlyHref: true,
    backend: {
      managed: { label: "Vercel Sandbox", Logo: LogoIconVercel },
      "self-hosted": { label: "Docker", Logo: SiDocker },
    },
  },
  {
    icon: <IconLinked className="mt-0.5 shrink-0 text-gray-1000" size={18} />,
    title: "Connection SDK",
    titleByMode: {
      managed: "Vercel Connection SDK",
      "self-hosted": "Connection",
    },
    description: "MCP/HTTP endpoints",
    href: "https://vercel.com/docs/connect",
    managedOnlyHref: true,
    backend: {
      managed: { label: "Vercel Connect", Logo: LogoIconVercel },
      "self-hosted": { label: "Snowflake API", Logo: SiSnowflake },
    },
  },
  {
    icon: <IconWrench className="mt-0.5 shrink-0 text-gray-1000" size={18} />,
    title: "Tools & Subagents",
    description: "Functions, child agents",
  },
];

const WORKFLOW_BACKEND: Record<Mode, Backend> = {
  managed: { label: "Vercel Workflows", Logo: LogoIconVercel },
  "self-hosted": {
    label: "Postgres (@workflow/world-postgres)",
    Logo: SiPostgresql,
  },
};

const CHANNELS = [
  "Slack",
  "Discord",
  "Web Chat",
  "Google Chat",
  "Microsoft Teams",
  "WhatsApp",
  "API",
  "Cron",
  "Twilio",
  "Linear",
  "GitHub",
  "Telegram",
];

const CAPTIONS: Record<Mode, string> = {
  managed:
    "Fully managed via Vercel. Sandboxes, durable workflows, model routing, and observability handled for you.",
  "self-hosted":
    "You can deploy anywhere. Postgres-backed durability, Docker sandbox, Ansible deploy, zero managed services.",
};

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <span className="font-mono font-medium uppercase tracking-[0.1em] text-gray-1000 text-label-14">
      {children}
    </span>
  );
}

function BackendChip({ backend }: { backend: Backend }): JSX.Element {
  return (
    <div className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-gray-1000 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200 motion-safe:ease-out">
      <backend.Logo className="shrink-0" color="default" size={13} />
      <span className="text-gray-1000 text-copy-13">{backend.label}</span>
    </div>
  );
}

function PrimitiveCard({
  icon,
  title,
  description,
  href,
  backend,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
  backend?: Backend;
}): JSX.Element {
  const body = (
    <>
      {icon}
      <div className="flex flex-col gap-1">
        <span className="font-medium text-gray-1000 text-copy-14">{title}</span>
        <span className="text-gray-900 text-copy-14">{description}</span>
        {backend ? <BackendChip key={backend.label} backend={backend} /> : null}
      </div>
    </>
  );

  if (!href) {
    return <div className="flex items-start gap-2.5 rounded-lg p-4 material-small">{body}</div>;
  }

  return (
    <Link
      href={href}
      className="group relative flex items-start gap-2.5 rounded-lg p-4 transition-colors material-small hover:bg-background-200"
    >
      {body}
      <IconArrowUpRight
        className="absolute top-3 right-3 text-gray-900 opacity-0 transition-opacity group-hover:opacity-100"
        size={14}
      />
    </Link>
  );
}

export function ArchitectureDiagram() {
  const [mode, setMode] = useState<Mode>("self-hosted");
  const selfHosted = mode === "self-hosted";

  return (
    <section className="py-24 px-4">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-medium! text-heading-32 tracking-tighter text-gray-1000 sm:text-heading-40 text-balance">
          Built on open-source SDKs, yours to self-host
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          Swap any backend and self-host the whole runtime, with zero managed-infrastructure
          dependencies.
        </p>

        {/* Managed vs. self-hosted toggle drives the backend shown inside each card. */}
        <div className="mt-12 flex items-center justify-center gap-4 text-copy-14">
          <button
            type="button"
            onClick={() => setMode(selfHosted ? "managed" : "self-hosted")}
            aria-pressed={!selfHosted}
            className={cn(
              "cursor-pointer transition-colors",
              selfHosted ? "text-gray-900 hover:text-gray-1000" : "text-gray-1000",
            )}
          >
            Managed
          </button>
          <Switch
            checked={selfHosted}
            onCheckedChange={(checked) => setMode(checked ? "self-hosted" : "managed")}
            aria-label="Toggle deployment target"
            className="cursor-pointer"
          />
          <span className="text-copy-14">
            <button
              type="button"
              onClick={() => setMode(selfHosted ? "managed" : "self-hosted")}
              aria-pressed={selfHosted}
              className={cn(
                "cursor-pointer transition-colors",
                selfHosted ? "text-gray-1000" : "text-gray-900 hover:text-gray-1000",
              )}
            >
              Self-hosted
            </button>{" "}
            <Link
              href="https://github.com/vercel-labs/steve"
              className="text-gray-900 underline decoration-gray-400 underline-offset-2 transition-colors hover:text-gray-1000"
            >
              (example)
            </Link>
          </span>
        </div>

        <LogoEve className="mt-10 ml-5 text-gray-1000" height={13} />
        <div className="mt-3 flex flex-col gap-4 lg:flex-row">
          {/* Runtime */}
          <div className="relative flex flex-1 flex-col gap-4 rounded-xl p-5">
            <GradientBorder />
            <div className="flex flex-col gap-1">
              <SectionLabel>Runtime</SectionLabel>
              <span className="text-gray-900 text-copy-14">
                Durable execution, state persistence, event streaming
              </span>
            </div>

            <PrimitiveCard
              icon={<IconWorkflow className="mt-0.5 shrink-0 text-gray-1000" size={18} />}
              title="Durable Workflow"
              description="Checkpointed steps, park between messages, resume on delivery"
              href="https://workflow-sdk.dev/worlds"
              backend={WORKFLOW_BACKEND[mode]}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {RUNTIME_ITEMS.map((item) => (
                <PrimitiveCard
                  key={item.title}
                  icon={item.icon}
                  title={item.titleByMode?.[mode] ?? item.title}
                  description={item.description}
                  href={item.managedOnlyHref && selfHosted ? undefined : item.href}
                  backend={item.backend?.[mode]}
                />
              ))}
            </div>
          </div>

          {/* Channel */}
          <div className="relative flex flex-col gap-4 rounded-xl p-5 lg:w-[240px] lg:shrink-0">
            <GradientBorder />
            <div className="flex flex-col gap-1">
              <SectionLabel>Channel</SectionLabel>
              <span className="text-gray-900 text-copy-14">Where your agent gets surfaced</span>
            </div>

            <Link
              href="https://chat-sdk.dev/"
              className="group relative flex items-start gap-2.5 overflow-hidden rounded-lg p-4 transition-colors material-small hover:bg-background-200 lg:h-0 lg:min-h-0 lg:grow"
            >
              <IconMessage className="mt-0.5 shrink-0 text-gray-1000" size={18} />
              <div className="flex flex-1 flex-col gap-2">
                <span className="font-medium text-gray-1000 text-copy-14">Chat SDK</span>
                <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 lg:grid-cols-1">
                  {CHANNELS.map((channel) => (
                    <span key={channel} className="text-gray-1000 text-copy-14">
                      {channel}
                    </span>
                  ))}
                </div>
              </div>
              <IconArrowUpRight
                className="absolute top-3 right-3 z-10 text-gray-900 opacity-0 transition-opacity group-hover:opacity-100"
                size={14}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-20 bg-linear-to-t from-background-100 to-transparent lg:block"
              />
            </Link>
          </div>
        </div>

        <p className="mx-auto mt-6 max-w-2xl text-center text-gray-900 text-copy-14 text-balance">
          {CAPTIONS[mode]}
          {selfHosted ? (
            <>
              {" "}
              <Link
                href="https://github.com/vercel-labs/steve"
                className="inline-flex items-center gap-0 text-gray-1000 underline decoration-gray-400 underline-offset-2"
              >
                See the example
                <IconArrowUpRightSmall className="text-gray-900" size={16} />
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}
