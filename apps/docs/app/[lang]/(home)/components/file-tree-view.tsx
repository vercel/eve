"use client";

import { type ReactNode, useState } from "react";
import { IconPlusCircle } from "@/components/geistcn-icons";
import { cn } from "@/lib/utils";

export interface FileTreeItem {
  name: string;
  fileName: string;
  /** File-type icon shown beside the file name in the code panel header. */
  icon: ReactNode;
  /** Pre-highlighted code, rendered on the server through the geistdocs CodeBlock. */
  code: ReactNode;
}

export function FileTreeView({ items }: { items: FileTreeItem[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The first file is "added" by default; every other file is optional and
  // only counts as added once the user clicks it.
  const [visited, setVisited] = useState<ReadonlySet<number>>(() => new Set([0]));
  const selected = items[selectedIndex];

  function select(index: number) {
    setSelectedIndex(index);
    setVisited((prev) => new Set(prev).add(index));
  }

  return (
    // Full-width container so the header divider can bleed to the page frame's
    // vertical borders, forming a cross with the layout grid.
    <div className="relative mt-16">
      {/* Grid line aligned exactly with the card header's border-b. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-12 -left-4 -right-4 border-t sm:-left-12 sm:-right-12"
      />
      <div className="mx-auto max-w-5xl">
        <div className="relative overflow-hidden rounded-xl border bg-background-100 shadow-sm">
          <div className="grid md:grid-cols-[240px_1fr]">
            {/* Sidebar */}
            <div className="border-b md:border-r md:border-b-0">
              <div className="flex h-12 items-center gap-2 border-b px-4">
                <span className="text-sm font-medium text-gray-1000">agent/</span>
                <span className="ml-auto text-gray-900 text-label-13">
                  {visited.size} {visited.size === 1 ? "file" : "files"}
                </span>
              </div>
              <div className="space-y-0.5 p-2">
                {items.map((item, i) => {
                  const added = visited.has(i);
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => select(i)}
                      className={cn(
                        "group flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left transition-colors",
                        selectedIndex === i ? "bg-gray-100" : "hover:bg-gray-100/60",
                      )}
                    >
                      <span
                        className={cn("ml-2 text-sm", added ? "text-gray-1000" : "text-gray-700")}
                      >
                        {item.name}
                      </span>
                      {i > 0 && !added ? (
                        <IconPlusCircle
                          aria-hidden
                          className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"
                          color="gray-700"
                          size={16}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Code panel */}
            <div className="flex min-w-0 flex-col">
              <div className="flex h-12 items-center gap-2 border-b px-4">
                {selected.icon}
                <span className="text-sm text-gray-1000">{selected.fileName}</span>
                {selectedIndex > 0 ? (
                  <span className="ml-auto font-mono uppercase tracking-[0.1em] text-gray-900 text-label-12-mono">
                    Optional
                  </span>
                ) : null}
              </div>
              {/* Re-keyed per file so the code subtly flies in on selection. */}
              <div
                key={selected.fileName}
                className="min-h-[360px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 motion-safe:ease-out [&>div]:mb-0"
              >
                {selected.code}
              </div>
            </div>
          </div>
          {/* Dissolve the lower edge of the card into its background. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-background-100 to-transparent"
          />
        </div>
      </div>
    </div>
  );
}
