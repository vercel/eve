"use client";

import { IconCheck, IconPlusCircle, IconTrash } from "@vercel/geistdocs/assets/icons";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

export interface FileTreeItem {
  /** Category name shown in the left "Configure your agent" column. */
  label: string;
  /** File/folder name shown in the IDE file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  /** Category icon (unused by this layout). */
  navIcon: ReactNode;
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
    // Clicking the active, already-added optional file deselects it again. The
    // default file (instructions.md) is always present and can't be removed.
    if (index !== 0 && index === selectedIndex && visited.has(index)) {
      const next = new Set(visited);
      next.delete(index);
      setVisited(next);
      const remaining = [...next];
      setSelectedIndex(remaining.length > 0 ? Math.max(...remaining) : 0);
      return;
    }
    setSelectedIndex(index);
    setVisited((prev) => new Set(prev).add(index));
  }

  function reset() {
    setSelectedIndex(0);
    setVisited(new Set([0]));
  }

  return (
    // Full-width container so the header divider can bleed to the page frame's
    // vertical borders, forming a cross with the layout grid.
    <div className="relative mt-16">
      {/* Grid line aligned with the card header's border-b, fading out toward
          the page frame on both sides. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-12 -left-4 -right-4 h-px sm:-left-12 sm:-right-12"
        style={{
          background:
            "linear-gradient(to right, transparent, var(--ds-gray-alpha-400) 18%, var(--ds-gray-alpha-400) 82%, transparent)",
        }}
      />
      <div className="mx-auto max-w-5xl">
        <div className="relative overflow-hidden rounded-t-xl border bg-background-100">
          <div className="grid md:grid-cols-[240px_1fr]">
            {/* Sidebar */}
            <div className="border-b md:border-r md:border-b-0">
              <div className="flex h-12 items-center gap-2 border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">agent/</span>
                {/* Counter slides left as the reset button reveals once more
                    than the default file is selected. */}
                <div className="ml-auto flex items-center">
                  <span className="whitespace-nowrap text-gray-900 text-label-13">
                    {visited.size} {visited.size === 1 ? "file" : "files"} selected
                  </span>
                  <button
                    type="button"
                    onClick={reset}
                    aria-label="Reset selection"
                    title="Reset"
                    className={cn(
                      "flex shrink-0 cursor-pointer items-center overflow-hidden text-gray-900 transition-all duration-300 ease-out hover:text-gray-1000",
                      visited.size > 1
                        ? "ml-2 w-4 opacity-100"
                        : "pointer-events-none ml-0 w-0 opacity-0",
                    )}
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
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
                        className={cn(
                          "ml-2 text-sm transition-colors",
                          added ? "text-gray-1000" : "text-gray-700 group-hover:text-gray-1000",
                        )}
                      >
                        {item.name}
                      </span>
                      {i > 0 && added ? (
                        <IconCheck className="-mr-1 ml-auto text-gray-1000" size={14} />
                      ) : i > 0 ? (
                        <IconPlusCircle
                          className="-mr-1 ml-auto text-gray-1000 opacity-0 transition-opacity group-hover:opacity-100"
                          size={14}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Code panel — fixed height so the card never reflows; the code
                area flexes to fill whatever the (content-hugging) description leaves. */}
            <div className="flex min-h-[492px] min-w-0 flex-col">
              <div className="flex h-12 items-center gap-2 border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{selected.fileName}</span>
                {selectedIndex > 0 ? (
                  <span className="ml-auto font-mono uppercase tracking-[0.1em] text-gray-900 text-label-12-mono">
                    Optional
                  </span>
                ) : null}
              </div>
              <p className="border-b px-4 py-3 text-gray-900 text-copy-14">
                {selected.description}
              </p>
              {/* Re-keyed per file so the code subtly flies in on selection. */}
              <div
                key={selected.fileName}
                className="grow pb-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 motion-safe:ease-out [&>div]:mb-0"
              >
                {selected.code}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-1 -mx-2 h-12 bg-linear-to-t from-background-200 to-transparent"
      />
    </div>
  );
}
