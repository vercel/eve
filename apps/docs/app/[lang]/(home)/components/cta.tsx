"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { githubLogo, linearLogo, notionLogo, slackLogo } from "@/lib/integrations/logos";
import { analyticsEvents } from "@/lib/analytics/events";

interface Agent {
  name: string;
  logo: ReactNode;
  prompt: string;
}

const AGENTS: Agent[] = [
  {
    name: "Software factory agents",
    logo: githubLogo({ className: "size-[18px]" }),
    prompt:
      "Plan features, open pull requests, review code, and keep GitHub issues moving from specification to production with clear human checkpoints.",
  },
  {
    name: "Support triage agent",
    logo: slackLogo({ className: "size-[18px]" }),
    prompt:
      "Triage new support requests in Slack, gather relevant context, suggest clear next steps, and route each issue to the right owner.",
  },
  {
    name: "Engineering project coordinator agent",
    logo: linearLogo({ className: "size-[18px]" }),
    prompt:
      "Track projects in Linear, surface blockers and overdue work, and send the team focused updates with owners and next actions.",
  },
];

export function CTA(): JSX.Element {
  return (
    <section className="px-4 py-24">
      <div className="mx-auto flex max-w-5xl flex-col gap-12 lg:gap-16">
        <h2 className="mx-auto max-w-2xl text-center text-heading-32 text-gray-1000 text-balance sm:text-heading-40">
          Deploy your first agent in less than 60 seconds on Vercel
        </h2>

        <div className="relative isolate flex min-h-[360px] items-center justify-center overflow-visible lg:min-h-[420px] lg:overflow-hidden">
          <div className="absolute inset-x-8 top-1/2 hidden -translate-y-[90px] grid-cols-2 lg:inset-x-20 lg:grid">
            {AGENTS.filter((_, index) => index !== 1).map((agent) => (
              <AgentCard agent={agent} key={agent.name} showConnections={false} />
            ))}
          </div>

          <div className="relative flex w-full max-w-[520px] flex-col items-center">
            <AgentCard agent={AGENTS[1]} className="relative z-10 shadow-lg" />
            <div className="relative z-30 mt-1 flex gap-2">
              <Button asChild size="lg" className="w-fit rounded-full text-base">
                <a
                  href="https://vercel.com/new/agent"
                  onClick={() =>
                    track(analyticsEvents.vercelAgentCreationOpened, { source: "home_footer" })
                  }
                >
                  Create agent on Vercel
                </a>
              </Button>
              <Button asChild size="lg" className="w-fit rounded-full text-base" variant="outline">
                <Link
                  href="/docs/getting-started"
                  onClick={() =>
                    track(analyticsEvents.gettingStartedOpened, { source: "home_footer" })
                  }
                  prefetch={true}
                >
                  Build locally
                </Link>
              </Button>
            </div>
          </div>

          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[34%] bottom-0 z-20 bg-linear-to-b from-transparent from-0% via-background-200 via-55% to-background-200"
          />
        </div>
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  className,
  showConnections = true,
}: {
  agent: Agent;
  className?: string;
  showConnections?: boolean;
}): JSX.Element {
  return (
    <article
      className={`rounded-2xl border bg-background-100 p-5 ${showConnections ? "min-h-52" : "h-44 overflow-hidden"} ${className ?? ""}`}
    >
      <div className="flex items-center gap-3 text-heading-16 text-gray-900">
        {agent.logo}
        {agent.name}
      </div>
      <p className="mt-4 line-clamp-3 text-copy-16 text-gray-1000">“{agent.prompt}”</p>
      {showConnections ? (
        <div className="mt-7 flex items-center gap-3 text-gray-700">
          <span className="text-gray-900 text-copy-13">Connects to</span>
          {slackLogo({ className: "size-[18px]" })}
          {linearLogo({ className: "size-[18px]" })}
          {notionLogo({ className: "size-[18px]" })}
        </div>
      ) : null}
    </article>
  );
}
