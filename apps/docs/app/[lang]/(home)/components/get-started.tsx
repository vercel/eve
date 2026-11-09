"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import type { JSX } from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { PrefetchLink } from "./section";

export function GetStarted(): JSX.Element {
  return (
    <section aria-labelledby="get-started-title" className="pt-16 pb-24 sm:pt-24 sm:pb-40">
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <h2
          className="text-balance text-heading-40 text-gray-1000 sm:text-heading-48 lg:text-heading-56"
          id="get-started-title"
        >
          Build your first agent today
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button
            className="w-fit rounded-full text-base"
            href="https://vercel.com/new/agent"
            onClick={() =>
              track(analyticsEvents.vercelAgentCreationOpened, { source: "home_footer" })
            }
            size="large"
          >
            Deploy on Vercel
          </Button>
          <Button
            className="w-fit rounded-full text-base"
            Component={PrefetchLink}
            href="/docs/guides/deployment/self-hosting"
            onClick={() => track(analyticsEvents.gettingStartedOpened, { source: "home_footer" })}
            size="large"
            variant="secondary"
          >
            Read the self-hosting guide
          </Button>
        </div>
      </div>
    </section>
  );
}
