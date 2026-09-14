export interface AuthoringTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export interface AuthoringTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly input: unknown;
  }>;
  readonly usage?: AuthoringTokenUsage;
}

export interface AuthoringWorldEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}
