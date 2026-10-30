"use client";

import { useState, type ReactNode } from "react";

import type { ToolActivity } from "./activity";
import { Check, ChevronDown, ChevronRight, Cross, Shield, Spinner } from "./icons";

export type GlyphStatus = "running" | "done" | "failed" | "waiting";

export function activityStatus(activity: ToolActivity): GlyphStatus {
  if (activity.state === "running") return "running";
  if (activity.state === "awaiting") return "waiting";
  if (activity.state === "error") return "failed";
  return "done";
}

/** The 16px status cell; it turns into a chevron on hover when the row can expand. */
export function StatusGlyph({
  status,
  expandable,
  open,
}: {
  status: GlyphStatus;
  expandable: boolean;
  open: boolean;
}) {
  return (
    <span className={`glyph glyph-${status}`}>
      <span className="glyph-status">
        {status === "running" ? (
          <Spinner size={12} />
        ) : status === "waiting" ? (
          <Shield size={11} />
        ) : status === "failed" ? (
          <Cross size={11} />
        ) : (
          <Check size={11} />
        )}
      </span>
      {expandable ? (
        <span className="glyph-chevron">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      ) : null}
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
  status,
}: {
  scale: TimelineScale | null;
  startedAt: number | undefined;
  endedAt: number | undefined;
  status: GlyphStatus;
}) {
  let segment: { left: number; width: number } | null = null;
  if (scale !== null && startedAt !== undefined) {
    const span = Math.max(scale.endMs - scale.startMs, 1);
    const end = endedAt ?? scale.endMs;
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
    <div className={`row row-stacked ${open ? "row-open" : ""} ${selected ? "row-selected" : ""}`}>
      <button
        aria-expanded={expandable ? open : undefined}
        className="row-trigger"
        onClick={() => {
          if (expandable) setOpen(!open);
          onSelect?.();
        }}
        type="button"
      >
        <StatusGlyph expandable={expandable} open={open} status={status} />
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
      </button>
      {open && expandable ? <div className="row-detail">{children}</div> : null}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="code">{children}</pre>;
}
