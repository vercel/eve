"use client";

import { track } from "@vercel/analytics";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { analyticsEvents } from "@/lib/analytics/events";
import type { RelatedResource } from "@/lib/integrations/data";

export const RelatedResources = ({
  integration,
  resources,
}: {
  integration: string;
  resources: RelatedResource[];
}) => (
  <ul className="mt-2 grid gap-3 sm:grid-cols-2">
    {resources.map((resource) => {
      const isInternal = resource.href.startsWith("/");
      return (
        <li className="grid sm:row-span-2 sm:grid-rows-subgrid" key={resource.href}>
          <Link
            className="group relative grid w-full gap-2 rounded-lg border bg-background-100 p-4 pr-9 transition-colors hover:border-gray-400 hover:bg-gray-100 sm:row-span-2 sm:grid-rows-subgrid"
            href={resource.href}
            onClick={() =>
              track(analyticsEvents.integrationRelatedResourceOpened, {
                integration,
                href: resource.href,
              })
            }
            prefetch={isInternal}
            rel={isInternal ? undefined : "noreferrer"}
            target={isInternal ? undefined : "_blank"}
          >
            {isInternal ? null : (
              <ArrowUpRightIcon
                aria-hidden
                className="absolute top-4 right-4 size-3.5 text-gray-800 transition-colors group-hover:text-gray-1000"
              />
            )}
            <span className="line-clamp-2 font-medium text-gray-1000 text-sm leading-snug [text-wrap:balance]">
              {resource.title}
            </span>
            <span className="line-clamp-3 text-gray-900 text-sm leading-relaxed">
              {resource.description}
            </span>
          </Link>
        </li>
      );
    })}
  </ul>
);
