"use client";

import { track } from "@vercel/analytics";
import { Input } from "@vercel/geistdocs/components/input";
import { InputGroup, InputGroupAddon } from "@vercel/geistdocs/components/input-group";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { analyticsEvents, getCountBucket, getQueryLengthBucket } from "@/lib/analytics/events";
import type { Integration, IntegrationType } from "@/lib/integrations/data";
import { cn } from "@/lib/utils";
import { IntegrationCard } from "./integration-card";

export type GalleryFilter = "all" | IntegrationType | "memory";

const FILTERS: { value: GalleryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "channel", label: "Channels" },
  { value: "connection", label: "Connections" },
  { value: "extension", label: "Extensions" },
  { value: "memory", label: "Memory" },
  { value: "instrumentation", label: "Observability" },
];

const FILTER_DESCRIPTIONS: Record<Exclude<GalleryFilter, "all">, string> = {
  channel:
    "Channels are the surfaces where users talk to your agent: Slack, Discord, web chat, and more.",
  connection:
    "Connections are the tools your agent calls during a run: services reached over MCP or OpenAPI.",
  extension: "Extensions are packages that add reusable tools, skills, connections, and hooks.",
  instrumentation:
    "Observability providers are OpenTelemetry backends that receive your agent's traces: every model call, tool execution, and turn.",
  memory: "Memory integrations let your agent store and recall information across sessions.",
};

interface GalleryProps {
  filter: GalleryFilter;
  integrations: Integration[];
}

export const Gallery = ({ filter, integrations }: GalleryProps) => {
  const [query, setQuery] = useState("");
  const lastTrackedSearch = useRef("");

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return integrations.filter((integration) => {
      if (filter === "memory" && !integration.keywords?.includes("memory")) {
        return false;
      }
      if (filter !== "all" && filter !== "memory" && integration.type !== filter) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const haystack = [integration.name, integration.tagline, ...(integration.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [integrations, filter, query]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;

    const searchKey = `${filter}:${normalizedQuery}`;
    if (searchKey === lastTrackedSearch.current) return;

    const timer = setTimeout(() => {
      track(analyticsEvents.integrationsSearched, {
        filter,
        query_length: getQueryLengthBucket(normalizedQuery),
        results: getCountBucket(results.length),
      });
      lastTrackedSearch.current = searchKey;
    }, 500);

    return () => clearTimeout(timer);
  }, [filter, query, results.length]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-3 min-[1024px]:flex-row min-[1024px]:items-center min-[1024px]:justify-between">
        <div
          aria-label="Integration filter"
          className="flex w-full gap-0.5 overflow-x-auto rounded-md border bg-background-100 p-1 [scrollbar-width:none] min-[1024px]:w-fit [&::-webkit-scrollbar]:hidden"
          role="group"
        >
          {FILTERS.map(({ value, label }) => (
            <Link
              aria-current={filter === value ? "page" : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap rounded px-3 py-1 font-medium text-sm no-underline transition-colors",
                filter === value
                  ? "bg-gray-100 text-gray-1000"
                  : "text-gray-900 hover:bg-gray-100/40 hover:text-gray-1000",
              )}
              href={value === "all" ? "/integrations" : `/integrations?filter=${value}`}
              key={value}
              onClick={() => track(analyticsEvents.integrationFilterSelected, { filter: value })}
              scroll={false}
            >
              {label}
            </Link>
          ))}
        </div>
        <InputGroup className="h-9 w-full bg-background min-[1024px]:w-64">
          <InputGroupAddon>
            <SearchIcon className="size-4 text-gray-700" />
          </InputGroupAddon>
          <Input
            aria-label="Search integrations"
            className="h-full border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations"
            value={query}
          />
        </InputGroup>
      </div>

      {filter !== "all" && <p className="text-gray-800 text-sm">{FILTER_DESCRIPTIONS[filter]}</p>}

      {results.length > 0 ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 min-[1024px]:grid-cols-2 min-[1200px]:grid-cols-3">
          {results.map((integration) => (
            <IntegrationCard
              integration={integration}
              key={integration.slug}
              onSelect={() =>
                track(analyticsEvents.integrationOpened, {
                  filter,
                  integration: integration.slug,
                  search: query.trim().length > 0,
                })
              }
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed py-16 text-center">
          <p className="font-medium text-gray-1000">No integrations found</p>
          <p className="text-gray-800 text-sm">Try a different search or filter.</p>
        </div>
      )}
    </div>
  );
};
