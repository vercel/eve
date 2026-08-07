"use client";

import { track } from "@vercel/analytics";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { analyticsEvents } from "@/lib/analytics/events";

export const IntegrationDocsLink = ({
  href,
  integration,
  type,
}: {
  href: string;
  integration: string;
  type: string;
}) => (
  <Link
    className="inline-flex w-fit items-center gap-1 text-gray-900 text-sm transition-colors hover:text-gray-1000"
    href={href}
    onClick={() => track(analyticsEvents.integrationDocsOpened, { integration, type })}
  >
    Read the full {type.toLowerCase()} docs
    <ArrowUpRightIcon className="size-3.5" />
  </Link>
);
