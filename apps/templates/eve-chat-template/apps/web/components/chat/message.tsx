"use client";

import type { EveDynamicToolPart, EveMessage, EveMessagePart } from "eve/react";
import { ChevronDownIcon, ChevronRightIcon, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STREAM_TEXT_TICK_MS = 60;
const STREAM_TEXT_CACHE_LIMIT = 40;
const streamingTextCache = new Map<string, string>();

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

export function AgentMessage({
  canRespond,
  isStreaming,
  message,
  onInputResponses,
}: {
  readonly canRespond: boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "group flex w-full min-w-0",
        isUser ? "justify-end" : "justify-start",
        message.metadata?.optimistic ? "opacity-90" : undefined,
      )}
    >
      <div
        className={cn(
          "min-w-0",
          isUser
            ? "max-w-[85%] rounded-[18px] border border-border/40 bg-muted/70 px-3 py-1.5 text-[15px] leading-6 text-foreground shadow-sm"
            : "w-full max-w-none text-sm leading-relaxed text-foreground",
        )}
      >
        <AgentMessageParts
          canRespond={canRespond}
          isUser={isUser}
          lastTextIndex={lastTextIndex}
          messageId={message.id}
          onInputResponses={onInputResponses}
          parts={message.parts}
          showCaret={isStreaming && message.role === "assistant"}
        />
      </div>
    </article>
  );
}

function AgentMessageParts({
  canRespond,
  isUser,
  lastTextIndex,
  messageId,
  onInputResponses,
  parts,
  showCaret,
}: {
  readonly canRespond: boolean;
  readonly isUser: boolean;
  readonly lastTextIndex: number;
  readonly messageId: string;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly parts: readonly EveMessagePart[];
  readonly showCaret: boolean;
}) {
  const elements: ReactNode[] = [];
  let pendingTools: EveDynamicToolPart[] = [];

  const flushTools = (isSettled: boolean) => {
    if (pendingTools.length === 0) {
      return;
    }

    const partsForGroup = pendingTools;

    elements.push(
      <ToolGroup
        canRespond={canRespond}
        isSettled={isSettled}
        key={`tools:${partsForGroup.map((part) => part.toolCallId).join(":")}`}
        onInputResponses={onInputResponses}
        parts={partsForGroup}
      />,
    );
    pendingTools = [];
  };

  parts.forEach((part, index) => {
    if (part.type === "dynamic-tool") {
      pendingTools.push(part);
      return;
    }

    flushTools(true);
    const key = partKey(part, index);

    elements.push(
      <AgentMessagePart
        canRespond={canRespond}
        isUser={isUser}
        key={key}
        onInputResponses={onInputResponses}
        part={part}
        showCaret={showCaret && index === lastTextIndex}
        streamKey={`${messageId}:${key}`}
      />,
    );
  });

  flushTools(!showCaret);

  return elements;
}

function AgentMessagePart({
  canRespond,
  isUser,
  onInputResponses,
  part,
  showCaret,
  streamKey,
}: {
  readonly canRespond: boolean;
  readonly isUser: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveMessagePart;
  readonly showCaret: boolean;
  readonly streamKey: string;
}) {
  switch (part.type) {
    case "step-start":
      return null;
    case "text":
      return isUser ? (
        <UserTextPart text={part.text} />
      ) : (
        <AssistantTextPart showCaret={showCaret} streamKey={streamKey} text={part.text} />
      );
    case "reasoning":
      return <ReasoningPart isStreaming={part.state === "streaming"} text={part.text} />;
    case "dynamic-tool":
      return null;
  }
}

function UserTextPart({ text }: { readonly text: string }) {
  return <div className="whitespace-pre-wrap break-words">{text}</div>;
}

function AssistantTextPart({
  showCaret,
  streamKey,
  text,
}: {
  readonly showCaret: boolean;
  readonly streamKey: string;
  readonly text: string;
}) {
  const smoothedText = useStreamingText(text, showCaret, streamKey);
  const isRevealActive = smoothedText.length > 0 && (showCaret || smoothedText !== text);
  const showVisibleCaret = showCaret && smoothedText.length > 0;

  return (
    <Markdown
      animated={isRevealActive ? { duration: 0, stagger: 0 } : undefined}
      caret={showVisibleCaret ? "block" : undefined}
      isAnimating={isRevealActive}
    >
      {smoothedText}
    </Markdown>
  );
}

function useStreamingText(text: string, isStreaming: boolean, streamKey: string) {
  const [visibleText, setVisibleText] = useState(() =>
    getInitialStreamingText(text, isStreaming, streamKey),
  );
  const visibleTextRef = useRef(visibleText);

  useEffect(() => {
    visibleTextRef.current = visibleText;
  }, [visibleText]);

  useEffect(() => {
    const current = visibleTextRef.current;

    if (!isStreaming && (current === text || !text.startsWith(current))) {
      if (current !== text) {
        visibleTextRef.current = text;
        rememberStreamingText(streamKey, text);
        setVisibleText(text);
      }

      return;
    }

    const catchUp = !isStreaming;
    let interval: number | undefined;

    const advance = () => {
      const next = nextStreamingText(visibleTextRef.current, text, catchUp);

      if (next !== visibleTextRef.current) {
        visibleTextRef.current = next;
        rememberStreamingText(streamKey, next);
        setVisibleText(next);
      }

      if (catchUp && next === text && interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };

    advance();

    if (catchUp && visibleTextRef.current === text) {
      return;
    }

    interval = window.setInterval(advance, STREAM_TEXT_TICK_MS);

    return () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [isStreaming, streamKey, text]);

  useEffect(() => {
    if (!isStreaming && visibleText === text) {
      streamingTextCache.delete(streamKey);
    }
  }, [isStreaming, streamKey, text, visibleText]);

  return visibleText;
}

function getInitialStreamingText(text: string, isStreaming: boolean, streamKey: string) {
  const cachedText = streamingTextCache.get(streamKey);

  if (cachedText && text.startsWith(cachedText)) {
    return cachedText;
  }

  return isStreaming ? "" : text;
}

function rememberStreamingText(streamKey: string, text: string) {
  if (!text) {
    return;
  }

  streamingTextCache.delete(streamKey);
  streamingTextCache.set(streamKey, text);

  if (streamingTextCache.size <= STREAM_TEXT_CACHE_LIMIT) {
    return;
  }

  const oldestKey = streamingTextCache.keys().next().value;

  if (oldestKey) {
    streamingTextCache.delete(oldestKey);
  }
}

function nextStreamingText(current: string, target: string, catchUp = false) {
  if (current === target) {
    return current;
  }

  if (!target.startsWith(current)) {
    return target;
  }

  const remaining = target.length - current.length;
  const step = catchUp
    ? remaining > 160
      ? 18
      : remaining > 80
        ? 12
        : remaining > 32
          ? 7
          : remaining > 12
            ? 4
            : 2
    : remaining > 160
      ? 6
      : remaining > 80
        ? 5
        : remaining > 32
          ? 3
          : remaining > 12
            ? 2
            : 1;

  return target.slice(0, current.length + Math.min(remaining, step));
}

function ReasoningPart({
  isStreaming,
  text,
}: {
  readonly isStreaming: boolean;
  readonly text: string;
}) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      setOpen(true);
    }
  }, [isStreaming]);

  return (
    <Collapsible className="my-3 w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={isStreaming ? "shimmer-text" : undefined}>
          {isStreaming ? "Thinking..." : "Reasoning"}
        </span>
        <ChevronDownIcon className={cn("size-4 transition-transform", open ? "rotate-180" : "")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 border-l border-border pl-4 text-muted-foreground">
        <Markdown>{text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolGroup({
  canRespond,
  isSettled,
  onInputResponses,
  parts,
}: {
  readonly canRespond: boolean;
  readonly isSettled: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly parts: readonly EveDynamicToolPart[];
}) {
  const shouldOpen = parts.some(needsInputResponse);
  const [open, setOpen] = useState(shouldOpen);
  const status = getSettledToolStatus(getToolGroupStatus(parts), isSettled && !shouldOpen);
  const label = summarizeToolGroup(parts, status);
  const canExpand = parts.length > 1 ? parts.some(hasToolDetails) : hasToolDetails(parts[0]!);

  useEffect(() => {
    if (shouldOpen) {
      setOpen(true);
    }
  }, [shouldOpen]);

  return (
    <Collapsible
      className="my-2 px-3"
      onOpenChange={canExpand ? setOpen : undefined}
      open={canExpand ? open : false}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex max-w-full items-center gap-2 py-0.5 text-left text-sm leading-6 text-muted-foreground transition-colors",
          canExpand ? "cursor-pointer hover:text-foreground" : "cursor-default",
        )}
        disabled={!canExpand}
      >
        <ToolStatusIcon status={status} />
        <span className="truncate">{label}</span>
        <span className="sr-only">{toolStatusLabel(status)}</span>
        {canExpand ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 self-center transition-all",
              open ? "rotate-90 opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {canExpand ? (
        <CollapsibleContent className="ml-2 border-l border-border/40 pl-3 pt-0.5 pb-1">
          {parts.length === 1 ? (
            <ToolDetails
              canRespond={canRespond}
              onInputResponses={onInputResponses}
              part={parts[0]!}
            />
          ) : (
            parts.map((part) => (
              <ToolCallItem
                canRespond={canRespond}
                isSettled={isSettled}
                key={part.toolCallId}
                onInputResponses={onInputResponses}
                part={part}
              />
            ))
          )}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function ToolCallItem({
  canRespond,
  isSettled,
  onInputResponses,
  part,
}: {
  readonly canRespond: boolean;
  readonly isSettled: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const shouldOpen = needsInputResponse(part);
  const [open, setOpen] = useState(shouldOpen);
  const status = getSettledToolStatus(getToolStatus(part), isSettled && !shouldOpen);
  const canExpand = hasToolDetails(part);

  useEffect(() => {
    if (shouldOpen) {
      setOpen(true);
    }
  }, [shouldOpen]);

  const button = (
    <button
      className={cn(
        "flex w-full items-center gap-2 py-0.5 text-left text-sm leading-6 text-muted-foreground transition-colors",
        canExpand ? "cursor-pointer hover:text-foreground" : "cursor-default",
      )}
      type="button"
    >
      <ToolStatusIcon status={status} />
      <ToolNameLabel part={part} />
      <span className="truncate text-foreground/80">{describeToolAction(part, status)}</span>
      {canExpand ? (
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 self-center transition-transform",
            open ? "rotate-90" : "",
          )}
        />
      ) : null}
    </button>
  );

  if (!canExpand) {
    return <div className="py-0.5">{button}</div>;
  }

  return (
    <Collapsible className="py-0.5" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>{button}</CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-5">
        <ToolDetails canRespond={canRespond} onInputResponses={onInputResponses} part={part} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolDetails({
  canRespond,
  onInputResponses,
  part,
}: {
  readonly canRespond: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const hasOutput = part.state === "output-available" || part.state === "output-error";

  return (
    <div className="space-y-1.5">
      <InputRequestActions
        canRespond={canRespond}
        onInputResponses={onInputResponses}
        part={part}
      />
      <ToolPayload label="input" value={part.input} />
      {hasOutput ? (
        <ToolPayload
          label={part.state === "output-error" ? "error" : "result"}
          tone={part.state === "output-error" ? "destructive" : "default"}
          value={part.state === "output-error" ? part.errorText : part.output}
        />
      ) : null}
    </div>
  );
}

function ToolStatusIcon({ status }: { readonly status: ToolStatus }) {
  const className = "size-3 shrink-0";

  if (status === "running") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center self-center">
        <Loader2Icon className={cn(className, "animate-spin")} />
      </span>
    );
  }

  if (status === "error" || status === "denied") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center self-center">
        <XIcon className={cn(className, "text-destructive")} />
      </span>
    );
  }

  return (
    <span className="flex size-4 shrink-0 items-center justify-center self-center">
      <CheckIcon className={cn(className, "text-emerald-500")} />
    </span>
  );
}

function ToolNameLabel({ part }: { readonly part: EveDynamicToolPart }) {
  return (
    <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {formatToolName(resolveToolName(part))}
    </span>
  );
}

function ToolPayload({
  label,
  tone = "default",
  value,
}: {
  readonly label: string;
  readonly tone?: "default" | "destructive";
  readonly value: unknown;
}) {
  if (value === undefined) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <pre
        className={cn(
          "max-h-56 overflow-auto rounded bg-muted/30 p-2 font-mono text-[11px] leading-5 text-muted-foreground",
          tone === "destructive" ? "bg-destructive/10 text-destructive" : undefined,
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  );
}

function InputRequestActions({
  canRespond,
  onInputResponses,
  part,
}: {
  readonly canRespond: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const [freeformText, setFreeformText] = useState("");
  const inputRequest = part.toolMetadata?.eve?.inputRequest;

  if (!inputRequest) {
    return null;
  }

  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );

  if (inputResponse) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
        <span className="text-muted-foreground">Responded: </span>
        <span className="font-medium">
          {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
        </span>
      </div>
    );
  }

  const sendTextResponse = () => {
    const text = freeformText.trim();
    if (!text) {
      return;
    }
    void onInputResponses([{ requestId: inputRequest.requestId, text }]);
    setFreeformText("");
  };

  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm text-muted-foreground">{inputRequest.prompt}</p>
      {inputRequest.options?.length ? (
        <div className="flex flex-wrap gap-2">
          {inputRequest.options.map((option) => (
            <Button
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onInputResponses([
                  {
                    optionId: option.id,
                    requestId: inputRequest.requestId,
                  },
                ]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {inputRequest.allowFreeform || inputRequest.display === "text" ? (
        <div className="flex gap-2">
          <Input
            disabled={!canRespond}
            onChange={(event) => setFreeformText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendTextResponse();
              }
            }}
            placeholder="Type a response"
            value={freeformText}
          />
          <Button
            disabled={!canRespond || freeformText.trim().length === 0}
            onClick={sendTextResponse}
            type="button"
          >
            Reply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type ToolStatus = "completed" | "denied" | "error" | "running";

function needsInputResponse(part: EveDynamicToolPart) {
  return Boolean(part.toolMetadata?.eve?.inputRequest && !part.toolMetadata.eve.inputResponse);
}

function hasToolDetails(part: EveDynamicToolPart) {
  if (isConnectionSearchTool(part)) {
    return false;
  }

  const hasInput = part.input !== undefined && formatPayload(part.input).trim().length > 0;
  const hasOutput =
    part.state === "output-available" && formatPayload(part.output).trim().length > 0;
  const hasError = part.state === "output-error" && part.errorText.trim().length > 0;

  return hasInput || hasOutput || hasError || Boolean(part.toolMetadata?.eve?.inputRequest);
}

function isConnectionSearchTool(part: EveDynamicToolPart) {
  const normalized = normalizeToolName(resolveToolName(part));

  return normalized.includes("connection") && normalized.includes("search");
}

function getToolStatus(part: EveDynamicToolPart): ToolStatus {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return "running";
    case "output-available":
      return "completed";
    case "output-denied":
      return "denied";
    case "output-error":
      return "error";
  }
}

function getSettledToolStatus(status: ToolStatus, isSettled: boolean): ToolStatus {
  return isSettled && status === "running" ? "completed" : status;
}

function getToolGroupStatus(parts: readonly EveDynamicToolPart[]): ToolStatus {
  const statuses = parts.map(getToolStatus);

  if (statuses.includes("error")) {
    return "error";
  }

  if (statuses.includes("denied")) {
    return "denied";
  }

  if (statuses.includes("running")) {
    return "running";
  }

  return "completed";
}

function toolStatusLabel(status: ToolStatus) {
  switch (status) {
    case "completed":
      return "Complete";
    case "denied":
      return "Denied";
    case "error":
      return "Error";
    case "running":
      return "Running";
  }
}

function summarizeToolGroup(parts: readonly EveDynamicToolPart[], status: ToolStatus) {
  if (parts.length === 1) {
    return describeToolAction(parts[0]!, status);
  }

  const counts = new Map<string, number>();

  for (const part of parts) {
    const category = toolCategory(resolveToolName(part));
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const labels: string[] = [];
  const order: [string, string, string, string][] = [
    ["searched", "Searched", "thing", "things"],
    ["read", "Read", "item", "items"],
    ["wrote", "Wrote", "item", "items"],
    ["ran", "Ran", "action", "actions"],
  ];

  for (const [key, verb, singular, plural] of order) {
    const count = counts.get(key);

    if (count) {
      labels.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
    }
  }

  return labels.join(", ") || `Used ${parts.length} tools`;
}

function toolCategory(name: string) {
  const normalized = normalizeToolName(name);

  if (normalized.includes("search") || normalized.includes("grep")) {
    return "searched";
  }

  if (normalized.includes("read") || normalized.includes("fetch")) {
    return "read";
  }

  if (normalized.includes("write") || normalized.includes("edit")) {
    return "wrote";
  }

  return "ran";
}

function describeToolAction(part: EveDynamicToolPart, status = getToolStatus(part)) {
  const name = resolveToolName(part);
  const normalized = normalizeToolName(name);
  const input = asRecord(part.input);
  const query = readString(input, ["query", "q", "search", "pattern", "prompt", "text"]);
  const path = readString(input, ["path", "filePath", "filename"]);
  const command = readString(input, ["command", "cmd"]);
  const url = readString(input, ["url", "href"]);
  const connection = readString(input, ["connection", "connectionName", "connector", "source"]);

  if (normalized.includes("connection") && normalized.includes("search")) {
    const verb = status === "running" ? "Searching" : "Searched";
    const connectionName = resolveConnectionName(name, connection);

    if (connectionName) {
      return `${verb} ${formatDisplayName(connectionName)}`;
    }

    if (query && query !== "*") {
      return `${verb} ${truncateInline(query, 72)}`;
    }

    return `${verb} connections`;
  }

  if (normalized.includes("search") || normalized.includes("grep")) {
    return query ? `Searched ${truncateInline(query, 72)}` : `Searched ${formatToolName(name)}`;
  }

  if (normalized.includes("read")) {
    return path ? `Read ${shortenPath(path)}` : `Read ${formatToolName(name)}`;
  }

  if (normalized.includes("write") || normalized.includes("edit")) {
    return path ? `Changed ${shortenPath(path)}` : `Changed ${formatToolName(name)}`;
  }

  if (normalized.includes("fetch")) {
    return url ? `Fetched ${truncateInline(url, 72)}` : `Fetched ${formatToolName(name)}`;
  }

  if (command) {
    return truncateInline(command, 72);
  }

  if (path) {
    return shortenPath(path);
  }

  if (query) {
    return truncateInline(query, 72);
  }

  return `Used ${formatToolName(name)}`;
}

function resolveToolName(part: EveDynamicToolPart) {
  const metadataName = part.toolMetadata?.eve?.name;
  return metadataName && metadataName !== "unknown" ? metadataName : part.toolName;
}

function formatToolName(name: string) {
  return normalizeToolName(name)
    .replace(/^connection search$/, "connection search")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToolName(name: string) {
  return name.replace(/__/g, " ").replace(/[_-]/g, " ").trim().toLowerCase();
}

function formatDisplayName(value: string) {
  const cleaned = value
    .replace(/^mcp\./, "")
    .replace(/\.com(?:\/.*)?$/, "")
    .replace(/[_-]/g, " ");

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveConnectionName(toolName: string, inputConnection?: string | null) {
  if (inputConnection && inputConnection !== "*") {
    return inputConnection;
  }

  const tokens = normalizeToolName(toolName).split(/\s+/).filter(Boolean);

  if (tokens[0] !== "connection" || tokens.length <= 2) {
    return null;
  }

  const connectionTokens = tokens
    .slice(1)
    .filter((token) => token !== "search" && token !== "tool" && token !== "tools");

  if (connectionTokens.length === 0) {
    return null;
  }

  return [...new Set(connectionTokens)].join(" ");
}

function shortenPath(filepath: string) {
  const parts = filepath.split("/").filter(Boolean);

  if (parts.length <= 2) {
    return filepath;
  }

  return `.../${parts.slice(-2).join("/")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | null, keys: readonly string[]) {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return truncateText(value, 4000);
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), 4000);
  } catch {
    return truncateText(String(value), 4000);
  }
}

function truncateInline(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "dynamic-tool":
      return part.toolCallId;
    default:
      return `${part.type}:${index}`;
  }
}
