import type { JSX } from "react";
import { InstallSwitcher } from "./install-switcher";
import { SessionTimeline } from "./session-timeline";

export function Hero({ tagline }: { tagline: string }): JSX.Element {
  return (
    <section className="grid items-center gap-14 pt-16 pb-12 sm:pt-24 lg:grid-cols-12 lg:gap-x-6 lg:pt-24 lg:pb-16">
      <div className="flex flex-col gap-6 lg:col-span-6 lg:pr-8">
        <h1 className="text-balance text-heading-48 text-gray-1000 sm:text-heading-56 xl:text-heading-64">
          Build production AI agents
        </h1>
        <p className="max-w-[34rem] text-pretty text-copy-18 text-gray-900 sm:text-copy-20">
          {tagline}
        </p>
        <InstallSwitcher className="mt-2" source="home_hero" />
      </div>
      <div className="min-w-0 lg:col-span-6">
        <SessionTimeline />
      </div>
    </section>
  );
}
