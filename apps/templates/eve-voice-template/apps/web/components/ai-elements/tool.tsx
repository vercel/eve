"use client";

import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

const compactCodeBlockClassName =
  "rounded-none border-0 bg-transparent [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:pt-2 [&_pre]:pb-3 [&_pre]:text-xs [&_code]:text-xs";

export type BashToolContentProps = ComponentProps<"div"> & {
  input: unknown;
  output: unknown;
  errorText: string | undefined;
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

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>
          <span className="text-muted-foreground">$ </span>
          {command ?? "…"}
        </code>
      </pre>
      {hasResult ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <code>
            <span className="mb-2 block font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
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
      ) : null}
    </div>
  );
};

const getRecordValue = (value: unknown, key: string): string | number | undefined => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];
  return typeof property === "string" || typeof property === "number" ? property : undefined;
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("overflow-hidden rounded-md bg-muted/50", className)} {...props}>
    <span className="block px-3 pt-3 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
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
  output: unknown;
  errorText: string | undefined;
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
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
        "overflow-x-auto rounded-md text-xs [&_table]:w-full",
        errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        className,
      )}
      {...props}
    >
      <span className="block px-3 pt-3 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </span>
      {errorText && <div className="px-3 pt-2 pb-3">{errorText}</div>}
      {Output}
    </div>
  );
};
