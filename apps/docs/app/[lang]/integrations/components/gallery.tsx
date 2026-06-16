"use client";

import { Input } from "@vercel/geistdocs/components/input";
import { InputGroup, InputGroupAddon } from "@vercel/geistdocs/components/input-group";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Integration, IntegrationType } from "@/lib/integrations/data";
import { cn } from "@/lib/utils";
import { IntegrationCard } from "./integration-card";

type Filter = "all" | IntegrationType;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "channel", label: "Channels" },
  { value: "connection", label: "Connections" },
];

const TYPE_DESCRIPTIONS: Record<IntegrationType, string> = {
  channel:
    "Channels are the surfaces where users talk to your agent: Slack, Discord, web chat, and more.",
  connection:
    "Connections are the tools your agent calls during a run: services reached over MCP or OpenAPI.",
};

interface GalleryProps {
  integrations: Integration[];
}

export const Gallery = ({ integrations }: GalleryProps) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return integrations.filter((integration) => {
      if (filter !== "all" && integration.type !== filter) {
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex gap-0.5 rounded-md border bg-background-100 p-1">
          {FILTERS.map(({ value, label }) => (
            <button
              className={cn(
                "rounded px-3 py-1 font-medium text-sm transition-colors",
                filter === value
                  ? "bg-gray-100 text-gray-1000"
                  : "text-gray-900 hover:bg-gray-100/40 hover:text-gray-1000",
              )}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <InputGroup className="h-9 bg-background sm:w-64">
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

      {filter !== "all" && (
        <p className="text-gray-800 text-sm">{TYPE_DESCRIPTIONS[filter as IntegrationType]}</p>
      )}

      {results.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((integration) => (
            <IntegrationCard integration={integration} key={integration.slug} />
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
