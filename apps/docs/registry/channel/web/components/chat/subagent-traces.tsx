"use client";

import type { MessageStreamEvent, SubagentCalledStreamEvent } from "eve/client";
import { ChevronRightIcon, CheckIcon, Loader2Icon, WrenchIcon, XIcon } from "lucide-react";
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
  readonly reasoning: string;
  readonly text: string;
};

type SubagentTraceTool = {
  readonly callId: string;
  readonly errorText?: string;
  readonly input: unknown;
  readonly name: string;
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
    <div className="my-3 space-y-2">
      {traces.map((trace) => (
        <SubagentTraceView key={trace.callId} trace={trace} />
      ))}
    </div>
  );
}

function SubagentTraceView({ trace }: { readonly trace: SubagentTrace }) {
  const [open, setOpen] = useState(trace.status === "running");
  useEffect(() => {
    if (trace.status === "running") setOpen(true);
  }, [trace.status]);

  const detailCount = trace.steps.length + trace.tools.length;
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md py-1 text-left text-muted-foreground text-sm transition-colors hover:text-foreground">
        <TraceStatus status={trace.status} />
        <span>
          {trace.status === "running" ? "Delegating to" : "Delegated to"} {trace.name}
        </span>
        {detailCount > 0 ? (
          <span className="text-muted-foreground/70">
            · {detailCount} {detailCount === 1 ? "update" : "updates"}
          </span>
        ) : null}
        <ChevronRightIcon
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-2 border-border/40 border-l pl-3">
        {detailCount === 0 ? (
          <p className="py-1 text-muted-foreground text-xs">Waiting for the subagent to begin…</p>
        ) : (
          <div className="space-y-2 py-1">
            {trace.steps.map((step) => (
              <div className="text-muted-foreground text-sm" key={step.id}>
                {step.reasoning ? <p className="text-xs">{step.reasoning}</p> : null}
                {step.text ? <p>{step.text}</p> : null}
              </div>
            ))}
            {trace.tools.map((tool) => (
              <div
                className="flex items-center gap-2 text-muted-foreground text-sm"
                key={tool.callId}
              >
                <TraceStatus status={tool.status} />
                <WrenchIcon className="size-3.5 shrink-0" />
                <span className="font-mono text-xs">{tool.name}</span>
                <span className="truncate text-xs">
                  {tool.errorText ?? describeInput(tool.input)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
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
      if (event.data.message !== null) trace.steps.push(blankStep(trace.steps.length + 1));
      break;
    case "actions.requested":
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        trace.tools.push({
          callId: action.callId,
          input: action.input,
          name: action.toolName,
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
  if (last) return last;
  const step = blankStep(1);
  trace.steps.push(step);
  return step;
}

function blankStep(index: number): SubagentTraceStep {
  return { id: `${index}`, reasoning: "", text: "" };
}

function describeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "Working…";
  }
}
