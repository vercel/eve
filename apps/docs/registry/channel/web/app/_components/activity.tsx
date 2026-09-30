"use client";

import type { ToolCallStatus } from "eve/react";
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import {
  type ActivityItem,
  agentActivity,
  describeInput,
  formatJson,
  itemStatus,
} from "./conversation-view";

/** The work between two stretches of prose, folded to one line until opened. */
export function Activity({ items }: { readonly items: readonly ActivityItem[] }) {
  const [open, setOpen] = useState(false);
  const working = items.some((item) => itemStatus(item) === "running");
  const steps = items.length === 1 ? "1 step" : `${items.length} steps`;

  return (
    <div className="text-[13px]">
      <button
        aria-expanded={open}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {working ? (
          <Shimmer as="span" duration={1}>
            Working
          </Shimmer>
        ) : (
          <span>{steps}</span>
        )}
      </button>
      {open ? <ActivityList className="mt-1.5" items={items} /> : null}
    </div>
  );
}

function ActivityList({
  className,
  items,
}: {
  readonly className?: string;
  readonly items: readonly ActivityItem[];
}) {
  return (
    <ul className={cn("space-y-0.5", className)}>
      {items.map((item) => (
        <li key={item.key}>
          {item.kind === "text" ? (
            <div className="py-1 text-foreground/80">
              <MessageResponse>{item.text}</MessageResponse>
            </div>
          ) : (
            <ActivityRow item={item} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ item }: { readonly item: Exclude<ActivityItem, { kind: "text" }> }) {
  const [open, setOpen] = useState(false);
  const status = itemStatus(item);

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left hover:bg-muted/50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <StatusIcon status={status} />
        <code className="shrink-0 font-mono text-[12px]">{rowName(item)}</code>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{rowDetail(item)}</span>
        <StatusText status={status} />
      </button>
      {open ? (
        <div className="mb-2 ml-[7px] space-y-2 border-l py-1 pl-3">
          <RowBody item={item} />
        </div>
      ) : null}
    </div>
  );
}

function rowName(item: Exclude<ActivityItem, { kind: "text" }>): string {
  switch (item.kind) {
    case "reasoning":
      return "reasoning";
    case "auth":
      return `sign-in:${item.part.name}`;
    case "tool":
      return item.agent === undefined ? item.name : `subagent:${item.name}`;
  }
}

function rowDetail(item: Exclude<ActivityItem, { kind: "text" }>): string | undefined {
  switch (item.kind) {
    case "reasoning":
      return item.text;
    case "auth":
      return item.part.displayName;
    case "tool":
      return describeInput(item.input);
  }
}

function RowBody({ item }: { readonly item: Exclude<ActivityItem, { kind: "text" }> }) {
  switch (item.kind) {
    case "reasoning":
      return (
        <div className="text-muted-foreground">
          <MessageResponse>{item.text}</MessageResponse>
        </div>
      );
    case "auth":
      return (
        <>
          <p className="text-muted-foreground">{item.part.description}</p>
          {item.state.errorText ? <ErrorText text={item.state.errorText} /> : null}
        </>
      );
    case "tool": {
      const thread = item.agent === undefined ? undefined : agentActivity(item.agent);
      return (
        <>
          <Payload label="input" value={item.input} />
          {thread === undefined ? null : thread.length === 0 ? (
            <p className="text-muted-foreground">No activity yet.</p>
          ) : (
            <ActivityList items={thread} />
          )}
          {item.state.errorText !== undefined ? (
            <ErrorText text={item.state.errorText} />
          ) : (
            <Payload label="output" value={item.state.output} />
          )}
        </>
      );
    }
  }
}

function Payload({ label, value }: { readonly label: string; readonly value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[11px] text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4">
        {formatJson(value)}
      </pre>
    </div>
  );
}

function ErrorText({ text }: { readonly text: string }) {
  return <p className="text-destructive">{text}</p>;
}

function StatusIcon({ status }: { readonly status: ToolCallStatus }) {
  const className = cn(
    "size-3.5 shrink-0 text-muted-foreground",
    status === "failed" && "text-destructive",
  );
  switch (status) {
    case "running":
      return <CircleDashedIcon className={className} />;
    case "awaiting-input":
      return <CircleDotIcon className={className} />;
    case "completed":
      return <CheckIcon className={className} />;
    case "failed":
      return <XIcon className={className} />;
    case "rejected":
      return <BanIcon className={className} />;
    case "cancelled":
    case "interrupted":
      return <CircleSlashIcon className={className} />;
  }
}

const STATUS_TEXT: Record<ToolCallStatus, string | undefined> = {
  "awaiting-input": "waiting for you",
  cancelled: "cancelled",
  completed: undefined,
  failed: "failed",
  interrupted: "interrupted",
  rejected: "denied",
  running: undefined,
};

function StatusText({ status }: { readonly status: ToolCallStatus }) {
  const text = STATUS_TEXT[status];
  if (text === undefined) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-xs text-muted-foreground",
        status === "failed" && "text-destructive",
      )}
    >
      {text}
    </span>
  );
}
