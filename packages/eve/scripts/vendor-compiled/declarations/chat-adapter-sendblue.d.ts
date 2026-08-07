import type { Logger } from "#compiled/chat/index.js";

export interface SendblueAdapterConfig {
  apiKey: string;
  apiSecret: string;
  defaultFromNumber: string;
  webhookSecret?: string;
  webhookSecretHeader?: string;
  statusCallbackUrl?: string;
  allowedServices?: SendblueService[];
}

export type SendblueService = "iMessage" | "SMS" | "RCS" | "sms";

export interface SendblueThreadId {
  fromNumber: string;
  contactNumber?: string;
  groupId?: string;
}

export interface SendblueMessagePayload {
  content: string;
  from_number: string;
  group_id: string;
  is_outbound: boolean;
  media_url: string;
  message_handle: string;
  message_type: "message" | "group" | string;
  number: string;
  participants: string[];
  service: string;
  status: string;
  to_number: string;
}

export interface SendblueAdapter {
  readonly name: "sendblue";
  markRead(threadId: string): Promise<void>;
}

export declare function createSendblueAdapter(
  config?: Partial<SendblueAdapterConfig> & { logger?: Logger },
): SendblueAdapter;
