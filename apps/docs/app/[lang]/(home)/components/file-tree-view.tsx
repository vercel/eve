"use client";

import { type ReactNode, useState } from "react";
import { IconCheck, IconPlusCircle, IconRefreshCounterClockwise } from "@/components/geistcn-icons";
import { cn } from "@/lib/utils";
import { GradientBorder } from "./gradient-border";

export interface FileTreeItem {
  /** Category name shown in the left "Configure your agent" column. */
  label: string;
  /** File/folder name shown in the IDE file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  /** Category icon for the left column. */
  navIcon: ReactNode;
  /** Pre-highlighted code, rendered on the server through the geistdocs CodeBlock. */
  code: ReactNode;
}

export function FileTreeView({ items }: { items: FileTreeItem[] }) {
  // The IDE lists files in selection order. Instructions (index 0) is always
  // present and pinned first; newly added files append after it.
  const [order, setOrder] = useState<number[]>(() => [0]);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = items[activeIndex];

  function toggle(index: number) {
    if (order.includes(index)) {
      // Instructions can't be removed — clicking it just opens it.
      if (index === 0) {
        setActiveIndex(0);
        return;
      }
      const next = order.filter((i) => i !== index);
      setOrder(next);
      if (activeIndex === index) {
        setActiveIndex(next[next.length - 1] ?? 0);
      }
      return;
    }
    setOrder((prev) => [...prev, index]);
    setActiveIndex(index);
  }

  function reset() {
    setOrder([0]);
    setActiveIndex(0);
  }

  return (
    <div className="mx-auto mt-16 flex max-w-5xl flex-col gap-4 lg:flex-row">
      {/* Configure your agent — a soft gradient card that drives which files exist in the IDE. */}
      <div className="relative rounded-xl lg:w-[264px] lg:shrink-0">
        <GradientBorder />
        <div className="flex h-12 items-center pl-4 pr-4.5">
          <span className="font-medium text-gray-1000 text-sm">Configure your agent</span>
          {/* Reset slides in once more than the default file is selected; its
              right edge lines up with the row check/plus icons. */}
          <button
            type="button"
            onClick={reset}
            aria-label="Reset selection"
            title="Reset"
            className={cn(
              "mr-1 flex shrink-0 cursor-pointer items-center overflow-hidden text-gray-900 transition-all duration-200 ease-out hover:text-gray-1000",
              order.length > 1 ? "ml-auto opacity-100" : "pointer-events-none ml-auto opacity-0",
            )}
          >
            <IconRefreshCounterClockwise aria-hidden size={16} />
          </button>
        </div>
        <div className="space-y-0.5 p-2">
          {items.map((item, i) => {
            const isAdded = order.includes(i);
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => toggle(i)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  isAdded ? "text-gray-1000" : "text-gray-700 hover:text-gray-1000",
                )}
              >
                {/* {item.navIcon} */}
                <span>{item.label}</span>
                {isAdded ? (
                  <IconCheck aria-hidden className="ml-auto" color="gray-1000" size={16} />
                ) : (
                  <IconPlusCircle
                    aria-hidden
                    className="ml-auto opacity-60 transition-opacity group-hover:opacity-100"
                    color="gray-900"
                    size={16}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* IDE: file tree + code panel. */}
      <div className="relative flex-1">
        <div className="min-w-0 flex-1 overflow-hidden rounded-t-xl border-t border-r border-l bg-background-100">
          <div className="grid md:grid-cols-[200px_1fr]">
            {/* File tree */}
            <div className="border-b md:border-r md:border-b-0">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">agent/</span>
                <span className="ml-auto whitespace-nowrap text-gray-900 text-label-13">
                  {order.length} {order.length === 1 ? "file" : "files"}
                </span>
              </div>
              <div className="space-y-0.5 p-2">
                {order.map((i) => (
                  <button
                    key={items[i].name}
                    type="button"
                    onClick={() => setActiveIndex(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm transition-colors",
                      activeIndex === i
                        ? "bg-gray-100 text-gray-1000"
                        : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                    )}
                  >
                    {items[i].name}
                  </button>
                ))}
              </div>
            </div>

            {/* Code panel — fixed height so switching files never reflows the
                card; the code area flexes to fill whatever the description leaves. */}
            <div className="flex min-h-[512px] min-w-0 flex-col">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{active.fileName}</span>
              </div>
              <p className="border-b px-4 py-3 text-gray-900 text-copy-14">{active.description}</p>
              {/* Re-keyed per file so the code subtly flies in on selection. */}
              <div
                key={active.fileName}
                className="grow pb-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 motion-safe:ease-out [&>div]:mb-0"
              >
                {active.code}
              </div>
            </div>
          </div>
        </div>
        {/* Fade the bottom of the code out toward the card background. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -mx-2 -bottom-2 h-16 bg-linear-to-t from-background-200 to-transparent"
        />
      </div>
    </div>
  );
}
