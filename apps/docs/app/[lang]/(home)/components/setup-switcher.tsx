"use client";

// TODO: clean up icons, via geistcn-assets once available
import {
  SiDigitalocean,
  SiDocker,
  SiJaeger,
  SiPostgresql,
  SiVercel,
} from "@icons-pack/react-simple-icons";
import Link from "next/link";
import { type ComponentType, useState } from "react";
import { IconArrowUpRight, IconOpenai } from "@/components/geistcn-icons";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Mode = "managed" | "self-hosted";

interface StackEntry {
  category: string;
  name: string;
  Logo: ComponentType<{
    size?: number;
    color?: string;
    className?: string;
    title?: string;
  }>;
  href?: string;
}

const STACKS: Record<Mode, StackEntry[]> = {
  managed: [
    {
      category: "Models",
      name: "AI Gateway",
      Logo: SiVercel,
      href: "https://vercel.com/ai-gateway",
    },
    {
      category: "Sandbox",
      name: "Vercel Sandbox",
      Logo: SiVercel,
      href: "https://vercel.com/sandbox",
    },
    {
      category: "Runtime",
      name: "Vercel Workflows",
      Logo: SiVercel,
      href: "https://vercel.com/workflow",
    },
    {
      category: "Observability",
      name: "Observability",
      Logo: SiVercel,
      href: "https://vercel.com/docs/observability",
    },
    {
      category: "Deploy",
      name: "Vercel",
      Logo: SiVercel,
      href: "https://vercel.com/docs/deployments",
    },
  ],
  "self-hosted": [
    { category: "Models", name: "GPT-5.4 API", Logo: IconOpenai },
    { category: "Sandbox", name: "Docker", Logo: SiDocker },
    {
      category: "Runtime",
      name: "Postgres",
      Logo: SiPostgresql,
      href: "https://workflow-sdk.dev/worlds/postgres",
    },
    { category: "Observability", name: "Jaeger", Logo: SiJaeger },
    { category: "Deploy", name: "DigitalOcean", Logo: SiDigitalocean },
  ],
};

const CAPTIONS: Record<Mode, string> = {
  managed: "Deploy to Vercel — sandboxes, durable workflows, and model routing handled for you.",
  "self-hosted":
    "Runs on a single 4 GB DigitalOcean box — Postgres-backed durability, Docker sandbox, Ansible deploy, zero managed services.",
};

export function SetupSwitcher() {
  const [mode, setMode] = useState<Mode>("self-hosted");
  const selfHosted = mode === "self-hosted";

  return (
    <div className="mt-12">
      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => setMode("managed")}
          aria-pressed={!selfHosted}
          className={cn(
            "cursor-pointer text-copy-14! transition-colors",
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
        <span className="text-copy-14!">
          <button
            type="button"
            onClick={() => setMode("self-hosted")}
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
            className="group inline-flex items-center gap-0.5 text-gray-900 underline decoration-gray-400 underline-offset-2 transition-colors hover:text-gray-1000"
          >
            (example
            <IconArrowUpRight aria-hidden color="gray-900" size={13} />)
          </Link>
        </span>
      </div>

      <div
        key={mode}
        className="mt-8 grid grid-cols-2 gap-3 px-5 sm:grid-cols-3 lg:grid-cols-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300 motion-safe:ease-out"
      >
        {STACKS[mode].map((entry) => {
          const body = (
            <>
              <entry.Logo className="shrink-0" color="default" size={22} title={entry.name} />
              <div className="flex min-w-0 flex-col">
                <span className="font-mono uppercase tracking-[0.08em] text-gray-900 text-label-12-mono">
                  {entry.category}
                </span>
                <span className="truncate font-medium text-gray-1000 text-copy-14">
                  {entry.name}
                </span>
              </div>
            </>
          );

          if (!entry.href) {
            return (
              <div
                key={entry.category}
                className="flex items-center gap-3 rounded-lg p-4 material-small"
              >
                {body}
              </div>
            );
          }

          return (
            <Link
              key={entry.category}
              href={entry.href}
              className="group relative flex items-center gap-3 rounded-lg p-4 transition-colors material-small hover:bg-background-200"
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
        })}
      </div>

      <p className="mx-auto mt-6 max-w-xl text-center text-gray-900 text-copy-14">
        {CAPTIONS[mode]}
      </p>
    </div>
  );
}
