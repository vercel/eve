"use client";

import type { MessageStreamEvent, SubagentCalledStreamEvent } from "eve/client";
import type { EveDynamicToolPart } from "eve/react";
import { ChevronDownIcon, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityContent, type ActivityPart } from "@/components/chat/message";
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
    <div className="mt-2 space-y-2">
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
    <Collapsible className="w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <TraceStatus status={trace.status} />
        <span className="min-w-0 truncate">
          {trace.status === "running" ? "Delegating to" : "Delegated to"} {formatName(trace.name)}
        </span>
        <span className="text-muted-foreground/70">· {traceStatusLabel(trace.status)}</span>
        <ChevronDownIcon className={cn("size-3 transition-transform", open ? "rotate-180" : "")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l border-border/60 pl-3 text-muted-foreground">
        {detailCount === 0 ? (
          <p className="text-sm">
            {trace.status === "running" ? "Waiting for the subagent to begin…" : "No activity."}
          </p>
        ) : (
          <ActivityContent
            canRespond={false}
            isSettled={trace.status !== "running"}
            onInputResponses={() => undefined}
            parts={traceActivityParts(trace)}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function traceActivityParts(trace: SubagentTrace): readonly ActivityPart[] {
  return [...trace.steps.filter((step) => step.reasoning), ...trace.tools]
    .sort((left, right) => left.order - right.order)
    .map((entry) => ("callId" in entry ? toolActivityPart(entry) : reasoningActivityPart(entry)));
}

function reasoningActivityPart(step: SubagentTraceStep): ActivityPart {
  return {
    state: step.finalized ? "done" : "streaming",
    stepIndex: step.order,
    text: step.reasoning,
    type: "reasoning",
  };
}

function toolActivityPart(tool: SubagentTraceTool): EveDynamicToolPart {
  const base = {
    input: tool.input,
    stepIndex: tool.order,
    toolCallId: tool.callId,
    toolName: tool.name,
    type: "dynamic-tool" as const,
  };

  if (tool.status === "running") {
    return { ...base, inputText: "", state: "input-streaming" };
  }
  if (tool.status === "failed") {
    return { ...base, errorText: tool.errorText ?? "Tool call failed", state: "output-error" };
  }
  return { ...base, output: tool.output, state: "output-available" };
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
