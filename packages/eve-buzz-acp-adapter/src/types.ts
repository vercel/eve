export interface BuzzRoute {
  channelId: string;
  triggeringEventId: string;
  replyTo?: string;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}
