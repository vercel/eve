"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import { type JSX, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";
import { EveLogoShader } from "./eve-logo-shader";
import { type InstallAudience, InstallSwitcher } from "./install-switcher";
import { PrefetchLink } from "./section";

export function GetStarted(): JSX.Element {
  const [audience, setAudience] = useState<InstallAudience>("humans");

  return (
    <section
      aria-labelledby="get-started-title"
      className="relative isolate flex flex-col items-center gap-8 pt-16 pb-16 text-center sm:pb-24 md:pt-48"
    >
      {/* The shader sizes itself in em, so the heading's font size sets the logo's scale. */}
      <div className="relative z-10 max-w-5xl text-heading-40 sm:text-heading-48 lg:text-heading-56">
        <EveLogoShader audience={audience} />
        <h2 className="relative text-balance text-gray-1000" id="get-started-title">
          Build your first agent today
        </h2>
      </div>
      <div className="z-10 flex flex-col items-center gap-6">
        <InstallSwitcher
          className="items-center"
          onAudienceChange={setAudience}
          source="home_footer"
        />
        <div className="flex flex-wrap justify-center gap-3">
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
