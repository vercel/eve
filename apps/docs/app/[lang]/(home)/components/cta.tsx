"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import Link from "next/link";
import { analyticsEvents } from "@/lib/analytics/events";

export function CTA() {
  return (
    <section className="px-4 py-10">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 md:flex-row">
        <h2 className="text-heading-32 text-gray-1000 sm:text-heading-40">
          Build your first agent today.
        </h2>
        <Button asChild size="lg" className="w-fit text-base h-12 rounded-full">
          <Link
            href="/docs/getting-started"
            onClick={() => track(analyticsEvents.gettingStartedOpened, { source: "home_footer" })}
          >
            Get started
          </Link>
        </Button>
      </div>
    </section>
  );
}
