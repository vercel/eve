import {
  IconFileText,
  IconFolderOpen,
  IconLinked,
  IconSandbox,
  IconWorkflow,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import type { JSX, ReactNode } from "react";
import { agentRuntimeDiagram } from "@/lib/geistdocs/agent-runtime-diagram";
import { cn } from "@/lib/utils";

function Environment({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-gray-alpha-400 bg-background-100 p-4 sm:p-5">
      <div className="flex flex-col gap-1 lg:min-h-16">
        <span className="font-mono font-medium uppercase tracking-[0.1em] text-gray-1000 text-label-14">
          {title}
        </span>
        <span className="break-words text-copy-14 text-gray-900">{description}</span>
      </div>
      {children}
    </section>
  );
}

function RuntimeCard({
  icon,
  title,
  description,
  paths,
  className,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  paths?: string[];
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex min-w-0 items-start gap-3 rounded-lg p-4 material-small", className)}>
      <span className="mt-0.5 shrink-0 text-gray-1000">{icon}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-copy-14 text-gray-1000">{title}</span>
        <span className="text-copy-14 text-gray-900">{description}</span>
        {paths ? (
          <span className="mt-1 flex flex-col font-mono text-copy-13 text-gray-900">
            {paths.map((path) => (
              <span key={path} className="break-words">
                {path}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SandboxBridge(): JSX.Element {
  return (
    <div className="relative flex min-h-20 items-center justify-center lg:min-h-0">
      <div
        aria-hidden
        className="absolute top-0 bottom-0 left-1/2 border-gray-alpha-700 border-l border-dashed lg:top-1/2 lg:bottom-auto lg:-right-4 lg:-left-4 lg:border-t lg:border-l-0"
      />
      <div className="relative rounded-lg border border-gray-alpha-700 bg-background-100 px-3 py-2 text-center shadow-sm">
        <code className="bg-transparent! p-0! font-medium text-copy-13! text-gray-1000!">
          {agentRuntimeDiagram.bridge}
        </code>
      </div>
    </div>
  );
}

/**
 * Shows the execution boundary between eve's trusted app runtime and isolated sandbox.
 */
export function AgentRuntimeDiagram(): JSX.Element {
  return (
    <figure
      aria-label="Agent loop and sandbox execution boundary"
      className="my-8 grid w-full min-w-0 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)]"
    >
      <Environment {...agentRuntimeDiagram.runtime}>
        <RuntimeCard icon={<IconWorkflow size={18} />} {...agentRuntimeDiagram.runtime.cards[0]} />
        <RuntimeCard icon={<IconWrench size={18} />} {...agentRuntimeDiagram.runtime.cards[1]} />
        <RuntimeCard icon={<IconLinked size={18} />} {...agentRuntimeDiagram.runtime.cards[2]} />
      </Environment>

      <SandboxBridge />

      <Environment {...agentRuntimeDiagram.sandbox}>
        <div className="grid gap-3">
          <RuntimeCard
            icon={<IconFileText size={18} />}
            {...agentRuntimeDiagram.sandbox.cards[0]}
            className="order-2 lg:order-1"
          />
          <RuntimeCard
            icon={<IconSandbox size={18} />}
            {...agentRuntimeDiagram.sandbox.cards[1]}
            className="order-1 lg:order-2"
          />
          <RuntimeCard
            icon={<IconFolderOpen size={18} />}
            {...agentRuntimeDiagram.sandbox.cards[2]}
            className="order-3"
          />
        </div>
      </Environment>
    </figure>
  );
}
