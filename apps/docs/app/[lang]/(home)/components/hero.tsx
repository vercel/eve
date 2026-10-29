import { Badge } from "@vercel/geistdocs/components/badge";
import { cacheLife } from "next/cache";
import type { JSX } from "react";
import { InstallSwitcher } from "./install-switcher";
import { SessionTimeline } from "./session-timeline";

/** eve's version on npm's `latest` tag, refreshed hourly; null if the registry can't be reached. */
async function latestVersion(): Promise<string | null> {
  "use cache";
  cacheLife("hours");

  try {
    const response = await fetch("https://registry.npmjs.org/-/package/eve/dist-tags");
    if (!response.ok) return null;
    const { latest } = (await response.json()) as { latest?: unknown };
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

/** The line under the install command: the current release, the license, and Beta. */
async function ReleaseLabels(): Promise<JSX.Element> {
  const version = await latestVersion();
  return (
    <div className="flex items-center justify-center gap-2 text-copy-13 text-gray-900">
      {version ? (
        <>
          <span className="tabular-nums">v{version}</span>
          <span aria-hidden className="text-gray-700">
            ·
          </span>
        </>
      ) : null}
      <span>Apache-2.0</span>
      <span aria-hidden className="text-gray-700">
        ·
      </span>
      <Badge size="sm" variant="pill">
        Beta
      </Badge>
    </div>
  );
}

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
        {/* As wide as the command, so the labels center under it. */}
        <div className="mt-2 flex w-fit flex-col gap-3">
          <InstallSwitcher source="home_hero" />
          <ReleaseLabels />
        </div>
      </div>
      <div className="min-w-0 lg:col-span-5 lg:col-start-8">
        <SessionTimeline />
      </div>
    </section>
  );
}
