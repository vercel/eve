export type TraceKind = "system" | "skill" | "context" | "tool" | "browser" | "result" | "error";

export interface TraceEvent {
  id: string;
  at: string;
  kind: TraceKind;
  name: string;
  summary: string;
  detail?: unknown;
  code?: string;
  durationMs?: number;
}

export interface BrowserState {
  provider: "local" | "browserbase" | "not-started";
  status: "idle" | "starting" | "active" | "error";
  proxies?: boolean;
  verified?: boolean;
  contextId?: string;
  contextStatus?: "draft" | "saved";
  proxyLocation?: BrowserProxyLocation;
  sessionId?: string;
  liveUrl?: string;
  url?: string;
  title?: string;
  screenshotDataUrl?: string;
}

export interface BrowserProxyLocation {
  country: string;
  state?: string;
  city?: string;
}

export type RunAction =
  | { action: "goto"; url: string }
  | { action: "click"; target: string }
  | { action: "fill"; target: string; value: string }
  | { action: "type"; target: string; value: string }
  | { action: "press"; target?: string; key: string }
  | { action: "select"; target: string; value: string }
  | { action: "wait"; milliseconds: number };

export interface ConversationState {
  id: string;
  traces: TraceEvent[];
  browser: BrowserState;
  screenshot?: Buffer;
}
