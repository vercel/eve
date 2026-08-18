export interface AuthoringTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AuthoringWorldEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}
