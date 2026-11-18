"use client";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useState, type ReactNode } from "react";

import type { ToolActivity } from "./activity";
import { ChevronRight } from "./icons";

export type GlyphStatus = "running" | "done" | "failed" | "waiting";

export function activityStatus(activity: ToolActivity): GlyphStatus {
  if (activity.state === "running") return "running";
  if (activity.state === "awaiting") return "waiting";
  if (activity.state === "error") return "failed";
  return "done";
}

/** The 16px cell before a step: a chevron when the step opens to its details, else empty. */
export function StatusGlyph({ expandable, open }: { expandable: boolean; open: boolean }) {
  return (
    <span aria-hidden="true" className={`glyph ${open ? "glyph-open" : ""}`}>
      {expandable ? <ChevronRight size={14} /> : null}
    </span>
  );
}

export interface TimelineScale {
  readonly startMs: number;
  readonly endMs: number;
}

/** Where a step ran within the turn: a thin baseline with the step's segment drawn on it. */
export function TimelineBar({
  scale,
  startedAt,
  endedAt,
  now,
  status,
}: {
  scale: TimelineScale | null;
  startedAt: number | undefined;
  endedAt: number | undefined;
  /** Where a step that hasn't ended reaches to. */
  now: number;
  status: GlyphStatus;
}) {
  let segment: { left: number; width: number } | null = null;
  if (scale !== null && startedAt !== undefined) {
    const span = Math.max(scale.endMs - scale.startMs, 1);
    const end = Math.min(endedAt ?? now, scale.endMs);
    const left = Math.min(Math.max(((startedAt - scale.startMs) / span) * 100, 0), 99);
    const width = Math.max(Math.min(((end - startedAt) / span) * 100, 100 - left), 1);
    segment = { left, width };
  }
  return (
    <span aria-hidden="true" className="tbar">
      {segment ? (
        <span
          className={`tbar-seg tbar-${status}`}
          style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
        />
      ) : null}
    </span>
  );
}

/** A one-line step that expands to its details. */
export function Row({
  status,
  name,
  preview,
  note,
  bar,
  duration,
  selected = false,
  onSelect,
  children,
}: {
  status: GlyphStatus;
  name: ReactNode;
  preview?: ReactNode;
  note?: ReactNode;
  bar?: ReactNode;
  duration?: string;
  selected?: boolean;
  onSelect?: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <Collapsible
      className={`row row-stacked row-${status} ${open ? "row-open" : ""} ${selected ? "row-selected" : ""}`}
      disabled={!expandable}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="row-trigger" onClick={() => onSelect?.()}>
        <StatusGlyph expandable={expandable} open={open} />
        <span className="row-main">
          <span className="row-name">{name}</span>
          {note ? (
            <span className="row-note">{note}</span>
          ) : preview ? (
            <span className="row-preview">{preview}</span>
          ) : null}
        </span>
        {bar}
        {duration !== undefined ? <span className="row-duration">{duration}</span> : null}
      </CollapsibleTrigger>
      {expandable ? <CollapsiblePanel className="row-detail">{children}</CollapsiblePanel> : null}
    </Collapsible>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="code">{children}</pre>;
}
