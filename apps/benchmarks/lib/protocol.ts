export interface AuthoringTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly input: unknown;
  }>;
}

export interface AuthoringWorldEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}
