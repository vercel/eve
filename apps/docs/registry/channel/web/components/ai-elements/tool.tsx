"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckIcon, ChevronRightIcon, CopyIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useEffect, useRef, useState } from "react";

import { CodeBlock } from "./code-block";

const compactCodeBlockClassName =
  "rounded-none border-0 bg-transparent [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:pt-2 [&_pre]:pb-3 [&_pre]:text-xs [&_code]:text-xs";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

export const getStatusIndicator = (status: ToolPart["state"]) =>
  status === "output-available" ? null : (
    <span className={cn("text-sm", status === "output-error" && "text-destructive")}>
      {statusLabels[status]}
    </span>
  );

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const displayName = title ?? derivedName;

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      {displayName === "bash" ? (
        <TerminalIcon className="size-4 shrink-0" />
      ) : (
        <WrenchIcon className="size-4 shrink-0" />
      )}
      <span className="text-sm">{displayName}</span>
      {getStatusIndicator(state)}
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, children, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("chat-disclosure text-popover-foreground outline-none", className)}
    {...props}
  >
    <div className="space-y-4 py-2">{children}</div>
  </CollapsibleContent>
);

export type BashToolContentProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const BashToolContent = ({
  className,
  input,
  output,
  errorText,
  ...props
}: BashToolContentProps) => {
  const command = getRecordValue(input, "command");
  const stdout = getRecordValue(output, "stdout") ?? (typeof output === "string" ? output : "");
  const stderr = getRecordValue(output, "stderr") ?? errorText ?? "";
  const exitCode = getRecordValue(output, "exitCode");
  const hasResult = Boolean(stdout || stderr || (typeof exitCode === "number" && exitCode !== 0));
  const outputText = [
    stdout ? String(stdout).trimEnd() : "",
    stderr ? String(stderr).trimEnd() : "",
    typeof exitCode === "number" && exitCode !== 0 ? `Exited with code ${exitCode}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <div className="group/tool-block relative">
        {command !== undefined ? (
          <ToolCopyButton label="command" getText={() => String(command)} />
        ) : null}
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 pr-10 font-mono text-xs leading-relaxed">
          <code>
            <span className="text-muted-foreground">$ </span>
            {command ?? "…"}
          </code>
        </pre>
      </div>
      {hasResult ? (
        <div className="group/tool-block relative">
          <ToolCopyButton label="output" getText={() => outputText} />
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            <code>
              <span className="mb-2 block pr-8 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
                Output
              </span>
              {stdout ? <span className="block">{String(stdout).trimEnd()}</span> : null}
              {stderr ? (
                <span className="block text-destructive">{String(stderr).trimEnd()}</span>
              ) : null}
              {typeof exitCode === "number" && exitCode !== 0 ? (
                <span className="block text-muted-foreground">Exited with code {exitCode}</span>
              ) : null}
            </code>
          </pre>
        </div>
      ) : null}
    </div>
  );
};

function ToolCopyButton({
  label: contentLabel,
  getText,
}: {
  label: string;
  getText: () => string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const label =
    status === "copied"
      ? `Copied ${contentLabel}`
      : status === "error"
        ? "Copy failed. Try again"
        : `Copy ${contentLabel}`;

  return (
    <Button
      aria-label={label}
      title={label}
      className="absolute top-2 right-2 z-10 text-muted-foreground opacity-0 transition-opacity group-hover/tool-block:opacity-100 group-focus-within/tool-block:opacity-100 [@media(hover:none)]:opacity-100"
      size="icon-xs"
      variant="ghost"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setStatus("copied");
        } catch {
          setStatus("error");
        }
      }}
    >
      {status === "copied" ? <CheckIcon /> : <CopyIcon />}
      <span className="sr-only" role="status">
        {status === "idle" ? "" : label}
      </span>
    </Button>
  );
}

const getRecordValue = (value: unknown, key: string): string | number | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];
  return typeof property === "string" || typeof property === "number" ? property : undefined;
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div
    className={cn("group/tool-block relative overflow-hidden rounded-md bg-muted/50", className)}
    {...props}
  >
    <ToolCopyButton label="parameters" getText={() => JSON.stringify(input, null, 2) ?? ""} />
    <span className="block px-3 pt-3 pr-10 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
      Parameters
    </span>
    <div>
      <CodeBlock
        className={compactCodeBlockClassName}
        code={JSON.stringify(input, null, 2)}
        language="json"
      />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  const contentRef = useRef<HTMLDivElement>(null);
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock
        className={compactCodeBlockClassName}
        code={JSON.stringify(output, null, 2)}
        language="json"
      />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock className={compactCodeBlockClassName} code={output} language="json" />;
  }

  return (
    <div
      className={cn(
        "group/tool-block relative rounded-md text-xs [&_table]:w-full",
        errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        className,
      )}
      {...props}
    >
      <ToolCopyButton
        label={errorText ? "error" : "result"}
        getText={() => contentRef.current?.innerText ?? ""}
      />
      <span className="block px-3 pt-3 pr-10 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </span>
      <div ref={contentRef} className="overflow-x-auto">
        {errorText && <div className="px-3 pt-2 pb-3">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
