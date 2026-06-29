"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface FileTreeItem {
  /** Category name (unused by this layout). */
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

export function FileTreeView({ items, heading }: { items: FileTreeItem[]; heading?: ReactNode }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = items[selectedIndex];

  // The viz pins while you scroll through it, stepping the open file by scroll
  // progress (scrollytelling). Disabled for reduced motion — then it's a plain
  // click-to-view browser.
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrolly, setScrolly] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setScrolly(true);
  }, []);

  useEffect(() => {
    if (!scrolly) return;
    const track = trackRef.current;
    if (!track) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const distance = track.offsetHeight - window.innerHeight;
        if (distance <= 0) return;
        const progress = Math.min(Math.max(-track.getBoundingClientRect().top / distance, 0), 1);
        setSelectedIndex(Math.min(items.length - 1, Math.floor(progress * items.length)));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrolly, items.length]);

  function handleSelect(index: number) {
    if (!scrolly || !trackRef.current) {
      setSelectedIndex(index);
      return;
    }
    // Scroll to the segment that maps to this file so the sticky view follows.
    const track = trackRef.current;
    const distance = track.offsetHeight - window.innerHeight;
    const targetProgress = (index + 0.5) / items.length;
    const top = window.scrollY + track.getBoundingClientRect().top + targetProgress * distance;
    // Jump straight to the file's segment — no smooth scroll, so the view
    // doesn't flip through the files in between on the way there.
    window.scrollTo({ top, behavior: "auto" });
  }

  const board = (
    <div className="relative mt-12">
      {/* Grid line aligned with the card header's border-b, fading out at the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-12 -left-4 -right-4 h-px sm:-left-14 sm:-right-14"
        style={{
          background:
            "linear-gradient(to right, transparent, var(--ds-gray-400) 7.5%, var(--ds-gray-400) 92.5%, transparent)",
        }}
      />
      <div className="mx-auto max-w-5xl">
        <div className="relative overflow-hidden rounded-t-xl border bg-background-100">
          <div className="grid md:grid-cols-[240px_1fr]">
            {/* Sidebar — the building blocks; click any to view it. */}
            <div className="border-b md:border-r md:border-b-0">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">agent/</span>
              </div>
              <div className="space-y-0.5 p-2">
                {items.map((item, i) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => handleSelect(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm",
                      // In scroll mode the active row is driven by scroll, so a
                      // color transition smears the highlight across rows on
                      // fast scroll — keep the switch instant. Hover stays
                      // crisp too; the smooth transition is for click mode.
                      !scrolly && "transition-colors",
                      selectedIndex === i
                        ? "bg-gray-100 text-gray-1000"
                        : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                    )}
                  >
                    {item.name}
                    {i > 0 ? (
                      <span className="ml-auto font-mono text-gray-500 text-label-12-mono">
                        optional
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            {/* Code panel — fixed height so the card never reflows; the code
                area flexes to fill whatever the (content-hugging) description leaves. */}
            <div className="flex min-h-[492px] min-w-0 flex-col">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{selected.fileName}</span>
              </div>
              <p className="border-b px-4 py-3 text-gray-900 text-copy-14">
                {selected.description}
              </p>
              {/* Content swaps in place (no keyed remount) so the previous file
                  never lingers as a ghost layer mid-transition. */}
              <div className="grow pb-6 [&>div]:mb-0">{selected.code}</div>
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

  const block = (
    <>
      {heading}
      {board}
    </>
  );

  if (!scrolly) {
    return <div className="mt-4">{block}</div>;
  }

  return (
    <div ref={trackRef} className="relative mt-4" style={{ height: `${items.length * 42}vh` }}>
      <div className="sticky top-[max(4rem,calc(50vh-20.5rem))]">{block}</div>
    </div>
  );
}
