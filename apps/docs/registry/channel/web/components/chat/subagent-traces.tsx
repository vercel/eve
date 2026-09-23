"use client";

import type { MessageStreamEvent, SubagentCalledStreamEvent } from "eve/client";
import { ChevronDownIcon, ChevronRightIcon, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type SubagentTrace = {
  readonly callId: string;
  readonly name: string;
  readonly parentTurnId: string;
  readonly status: "complete" | "failed" | "running";
  readonly steps: readonly SubagentTraceStep[];
  readonly tools: readonly SubagentTraceTool[];
};

type SubagentTraceStep = {
  readonly id: string;
  readonly order: number;
  readonly reasoning: string;
  readonly text: string;
  readonly finalized: boolean;
};

type SubagentTraceTool = {
  readonly callId: string;
  readonly errorText?: string;
  readonly input: unknown;
  readonly name: string;
  readonly order: number;
  readonly output?: unknown;
  readonly status: "complete" | "failed" | "running";
};

/**
 * Experimental browser follower for child sessions announced on the parent
 * stream. This intentionally lives in the scaffold while we learn the right
 * `useEveAgent` API; it follows only same-origin child stream paths and never
 * dispatches work into a child.
 */
export function useSubagentTraces(events: readonly MessageStreamEvent[]): readonly SubagentTrace[] {
  const calls = useMemo(
    () =>
      events.filter(
        (event): event is SubagentCalledStreamEvent => event.type === "subagent.called",
      ),
    [events],
  );
  const [traces, setTraces] = useState<Record<string, SubagentTrace>>({});
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    for (const called of calls) {
      if (controllers.current.has(called.data.callId)) continue;
      const controller = new AbortController();
      controllers.current.set(called.data.callId, controller);
      void followSubagent(called, controller.signal, (trace) =>
        setTraces((current) => ({ ...current, [trace.callId]: trace })),
      );
    }
  }, [calls]);

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    [],
  );

  return useMemo(
    () =>
      calls.flatMap((called) => {
        const trace = traces[called.data.callId];
        return trace ? [trace] : [initialTrace(called)];
      }),
    [calls, traces],
  );
}

export function SubagentTraces({ traces }: { readonly traces: readonly SubagentTrace[] }) {
  if (traces.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {traces.map((trace) => (
        <SubagentTraceView key={trace.callId} trace={trace} />
      ))}
    </div>
  );
}

function SubagentTraceView({ trace }: { readonly trace: SubagentTrace }) {
  const [open, setOpen] = useState(false);

  const detailCount = trace.steps.length + trace.tools.length;
  return (
    <Collapsible className="my-3 w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <TraceStatus status={trace.status} />
        <span className="min-w-0 truncate">
          {trace.status === "running" ? "Delegating to" : "Delegated to"} {formatName(trace.name)}
        </span>
        <span className="text-muted-foreground/70">· {traceStatusLabel(trace.status)}</span>
        <ChevronDownIcon className={cn("size-4 transition-transform", open ? "rotate-180" : "")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 border-l border-border pl-4 text-muted-foreground">
        {detailCount === 0 ? (
          <p className="text-sm">
            {trace.status === "running" ? "Waiting for the subagent to begin…" : "No activity."}
          </p>
        ) : (
          <TraceTimeline trace={trace} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TraceTimeline({ trace }: { readonly trace: SubagentTrace }) {
  const entries = [...trace.steps.filter((step) => step.reasoning), ...trace.tools].sort(
    (left, right) => left.order - right.order,
  );

  return (
    <div className="space-y-2 pb-1">
      {entries.map((entry) =>
        "callId" in entry ? (
          <SubagentToolRow key={entry.callId} tool={entry} />
        ) : (
          <div className="text-sm leading-6" key={entry.id}>
            <p className="mb-1 text-xs text-muted-foreground/70">Reasoning</p>
            <p className="whitespace-pre-wrap">{entry.reasoning}</p>
          </div>
        ),
      )}
    </div>
  );
}

function SubagentToolRow({ tool }: { readonly tool: SubagentTraceTool }) {
  const [open, setOpen] = useState(false);
  const hasDetails =
    tool.input !== undefined || tool.output !== undefined || tool.errorText !== undefined;

  return (
    <div className="min-w-0">
      <button
        className={cn(
          "flex max-w-full items-center gap-2 py-0.5 text-left text-sm leading-6 text-muted-foreground transition-colors",
          hasDetails ? "group/tool cursor-pointer hover:text-foreground" : "cursor-default",
        )}
        disabled={!hasDetails}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <TraceStatus status={tool.status} />
        <span className="truncate">{formatName(tool.name)}</span>
        <span className="text-muted-foreground/70">· {toolStatusLabel(tool.status)}</span>
        {hasDetails ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 transition-all",
              open ? "rotate-90 opacity-100" : "opacity-0 group-hover/tool:opacity-100",
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="ml-2 border-l border-border/40 py-0.5 pl-3">
          <div className="space-y-1.5">
            <TracePayload label="input" value={tool.input} />
            {tool.output !== undefined ? <TracePayload label="result" value={tool.output} /> : null}
            {tool.errorText ? (
              <TracePayload label="error" tone="error" value={tool.errorText} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TracePayload({
  label,
  tone = "default",
  value,
}: {
  readonly label: string;
  readonly tone?: "default" | "error";
  readonly value: unknown;
}) {
  if (value === undefined) return null;

  return (
    <div>
      <p className="text-muted-foreground/70">{label}</p>
      <pre
        className={cn(
          "max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground",
          tone === "error" && "text-destructive",
        )}
      >
        {describeInput(value)}
      </pre>
    </div>
  );
}

function toolStatusLabel(status: SubagentTraceTool["status"]) {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Complete";
}

function traceStatusLabel(status: SubagentTrace["status"]) {
  if (status === "running") return "Working";
  if (status === "failed") return "Failed";
  return "Complete";
}

function formatName(name: string) {
  return name
    .replace(/^subagent:/, "")
    .replace(/__/g, " · ")
    .replace(/[_-]/g, " ");
}

function TraceStatus({ status }: { readonly status: "complete" | "failed" | "running" }) {
  if (status === "running") return <Loader2Icon className="size-3.5 shrink-0 animate-spin" />;
  if (status === "failed") return <XIcon className="size-3.5 shrink-0 text-destructive" />;
  return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />;
}

async function followSubagent(
  called: SubagentCalledStreamEvent,
  signal: AbortSignal,
  publish: (trace: SubagentTrace) => void,
) {
  const trace: MutableTrace = initialTrace(called);
  publish(trace);
  try {
    const response = await fetch(called.data.childStreamPath, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok || !response.body) {
      trace.status = "failed";
      publish(trace);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        applyChildEvent(trace, JSON.parse(line) as MessageStreamEvent);
        publish({ ...trace, steps: [...trace.steps], tools: [...trace.tools] });
      }
    }
    if (!signal.aborted && trace.status === "running") {
      trace.status = "complete";
      publish({ ...trace, steps: [...trace.steps], tools: [...trace.tools] });
    }
  } catch {
    if (!signal.aborted) {
      trace.status = "failed";
      publish({ ...trace, steps: [...trace.steps], tools: [...trace.tools] });
    }
  }
}

function initialTrace(called: SubagentCalledStreamEvent): SubagentTrace {
  return {
    callId: called.data.callId,
    name: called.data.name,
    parentTurnId: called.data.turnId,
    status: "running",
    steps: [],
    tools: [],
  };
}

function applyChildEvent(trace: MutableTrace, event: MessageStreamEvent) {
  switch (event.type) {
    case "reasoning.appended":
      currentStep(trace).reasoning += event.data.reasoningDelta;
      break;
    case "message.appended":
      currentStep(trace).text += event.data.messageDelta;
      break;
    case "message.completed":
      if (event.data.message && currentStep(trace).text.length === 0)
        currentStep(trace).text = event.data.message;
      currentStep(trace).finalized = true;
      break;
    case "actions.requested":
      finalizeCurrentStep(trace);
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        trace.tools.push({
          callId: action.callId,
          input: action.input,
          name: action.toolName,
          order: nextTraceOrder(trace),
          status: "running",
        });
      }
      break;
    case "action.result": {
      const tool = trace.tools.find((candidate) => candidate.callId === event.data.result.callId);
      if (!tool) break;
      tool.status = event.data.status === "completed" ? "complete" : "failed";
      if (event.data.status === "completed" && event.data.result.kind === "tool-result") {
        tool.output = event.data.result.output;
      } else {
        tool.errorText = event.data.error?.message;
      }
      break;
    }
    case "session.completed":
    case "session.waiting":
      trace.status = "complete";
      break;
    case "session.failed":
      trace.status = "failed";
      break;
  }
}

type MutableTrace = {
  callId: string;
  name: string;
  parentTurnId: string;
  status: "complete" | "failed" | "running";
  steps: SubagentTraceStep[];
  tools: SubagentTraceTool[];
};

function currentStep(trace: MutableTrace): SubagentTraceStep {
  const last = trace.steps.at(-1);
  if (last && !last.finalized) return last;
  const step = blankStep(trace.steps.length + 1, nextTraceOrder(trace));
  trace.steps.push(step);
  return step;
}

function finalizeCurrentStep(trace: MutableTrace) {
  const last = trace.steps.at(-1);
  if (last) last.finalized = true;
}

function nextTraceOrder(trace: MutableTrace) {
  return trace.steps.length + trace.tools.length;
}

function blankStep(index: number, order = index - 1): SubagentTraceStep {
  return { finalized: false, id: `${index}`, order, reasoning: "", text: "" };
}

function describeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "Working…";
  }
}
