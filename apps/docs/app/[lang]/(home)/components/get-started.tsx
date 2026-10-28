"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import type { JSX } from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { EveLogoShader } from "./eve-logo-shader";
import { PrefetchLink } from "./section";

export function GetStarted(): JSX.Element {
  return (
    <section
      aria-labelledby="get-started-title"
      className="relative isolate pt-16 pb-16 sm:pb-24 md:pt-48"
    >
      {/* The shader sizes itself in em, so this row's heading size sets the logo's scale. On
          desktop it sits centered behind the heading and actions. */}
      <div className="relative z-10 flex flex-col gap-8 text-heading-40 sm:text-heading-48 md:flex-row md:items-center md:justify-between lg:text-heading-56">
        <EveLogoShader />
        <h2 className="relative text-balance text-gray-1000" id="get-started-title">
          Build your first agent today
        </h2>
        {/* The row sets heading type for the shader; the actions take back their own. */}
        <div className="relative flex flex-wrap gap-3 leading-normal tracking-normal">
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
