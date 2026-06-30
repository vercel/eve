import type { JSONSchema7 } from "@ai-sdk/provider";

export interface CodexAppServerInputText {
  readonly type: "text";
  readonly text: string;
}

export interface CodexAppServerInputImage {
  readonly type: "image";
  readonly url: string;
}

export type CodexAppServerInput = CodexAppServerInputText | CodexAppServerInputImage;

export interface CodexDynamicTool {
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly name: string;
}

export interface CodexAppServerToolCall {
  readonly arguments: unknown;
  readonly callId: string;
  readonly namespace: string | null;
  readonly requestId: number | string;
  readonly tool: string;
}

export interface CodexAppServerUsage {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface CodexAppServerListener {
  onCompleted(input: {
    readonly error?: string;
    readonly status: "completed" | "failed" | "interrupted";
  }): void;
  onError(error: Error): void;
  onTextDelta(input: { readonly delta: string; readonly id: string }): void;
  onToolCall(input: CodexAppServerToolCall): void;
  onUsage(usage: CodexAppServerUsage): void;
}

export interface CodexAppServerSession {
  dispose(): void;
  start(input: {
    readonly input: readonly CodexAppServerInput[];
    readonly listener: CodexAppServerListener;
    readonly model: string;
    readonly outputSchema?: JSONSchema7;
    readonly tools: readonly CodexDynamicTool[];
  }): Promise<void>;
}

export type CodexAppServerSessionFactory = () => CodexAppServerSession;
