import type { JSX } from "react";
import { InstallSwitcher } from "./install-switcher";
import { SessionTimeline } from "./session-timeline";

export function Hero({ tagline }: { tagline: string }): JSX.Element {
  return (
    // The same top and bottom padding scale as vercel.com's product heroes (front's
    // HeroSection: Section top/bottom 144), with text and visual centered between.
    <section className="grid items-center gap-14 pt-16 pb-16 md:pt-24 md:pb-24 lg:grid-cols-12 lg:gap-x-6 lg:pt-36 lg:pb-36">
      <div className="flex flex-col gap-6 lg:col-span-6 lg:pr-8">
        <h1 className="text-balance text-heading-48 text-gray-1000 sm:text-heading-56 xl:text-heading-64">
          Build production AI agents
        </h1>
        <p className="max-w-[34rem] text-pretty text-copy-18 text-gray-900 sm:text-copy-20">
          {tagline}
        </p>
        <InstallSwitcher className="mt-2" source="home_hero" />
      </div>
      <div className="min-w-0 lg:col-span-5 lg:col-start-8">
        <SessionTimeline />
      </div>
    </section>
  );
}
