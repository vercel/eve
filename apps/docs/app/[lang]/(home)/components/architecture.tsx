import Link from "next/link";
import type { JSX, ReactNode } from "react";
import {
  IconArrowUpRight,
  IconLinked,
  IconMessage,
  IconSandbox,
  IconSparkles,
  IconWorkflow,
  IconWrench,
} from "@/components/geistcn-icons";
import { GradientBorder } from "./gradient-border";
import { SetupSwitcher } from "./setup-switcher";

const RUNTIME_ITEMS: {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
}[] = [
  {
    icon: <IconSparkles className="mt-0.5 shrink-0" color="gray-1000" size={18} />,
    title: "AI SDK",
    description: "Model calls, streaming",
    href: "https://ai-sdk.dev/",
  },
  {
    icon: <IconSandbox className="mt-0.5 shrink-0" color="gray-1000" size={18} />,
    title: "Sandbox SDK",
    description: "Isolated execution",
    href: "https://vercel.com/docs/sandbox/sdk-reference",
  },
  {
    icon: <IconLinked className="mt-0.5 shrink-0" color="gray-1000" size={18} />,
    title: "Connection SDK",
    description: "MCP/HTTP endpoints",
    href: "/docs/connections/overview",
  },
  {
    icon: <IconWrench className="mt-0.5 shrink-0" color="gray-1000" size={18} />,
    title: "Tools & Subagents",
    description: "Functions, child agents",
  },
];

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
];

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <span className="font-mono font-medium uppercase tracking-[0.1em] text-gray-1000 text-label-14">
      {children}
    </span>
  );
}

function PrimitiveCard({
  icon,
  title,
  description,
  href,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
}): JSX.Element {
  const body = (
    <>
      {icon}
      <div className="flex flex-col gap-1">
        <span className="font-medium text-gray-1000 text-copy-14">{title}</span>
        <span className="text-gray-900 text-copy-14">{description}</span>
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
        aria-hidden
        className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100"
        color="gray-900"
        size={14}
      />
    </Link>
  );
}

export function ArchitectureDiagram() {
  return (
    <section className="px-4 py-24 sm:px-12">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-heading-32 font-semibold tracking-tighter text-gray-1000 sm:text-heading-40">
          Built on open-source SDKs, yours to self-host
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Each capability is its own open-source SDK — workflows, AI, sandbox, connections, and
          channels. Swap any backend and self-host the whole runtime, with zero
          managed-infrastructure dependencies.
        </p>
        <div className="mt-16 flex flex-col gap-4 lg:flex-row">
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
              icon={<IconWorkflow className="mt-0.5 shrink-0" color="gray-1000" size={18} />}
              title="Durable Workflow"
              description="Checkpointed steps, park between messages, resume on delivery"
              href="https://workflow-sdk.dev/worlds"
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {RUNTIME_ITEMS.map((item) => (
                <PrimitiveCard
                  key={item.title}
                  icon={item.icon}
                  title={item.title}
                  description={item.description}
                  href={item.href}
                />
              ))}
            </div>
          </div>

          {/* Channel */}
          <div className="relative flex flex-col gap-4 rounded-xl p-5 lg:w-[200px] lg:shrink-0">
            <GradientBorder />
            <div className="flex flex-col gap-1">
              <SectionLabel>Channel</SectionLabel>
              <span className="text-gray-900 text-copy-14">Where your agent gets surfaced</span>
            </div>

            <Link
              href="https://chat-sdk.dev/"
              className="group relative flex items-start gap-2.5 overflow-hidden rounded-lg p-4 transition-colors material-small hover:bg-background-200 lg:h-0 lg:min-h-0 lg:grow"
            >
              <IconMessage className="mt-0.5 shrink-0" color="gray-1000" size={18} />
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
                aria-hidden
                className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100"
                color="gray-900"
                size={14}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-20 bg-linear-to-t from-background-100 to-transparent lg:block"
              />
            </Link>
          </div>
        </div>

        <SetupSwitcher />
      </div>
    </section>
  );
}
