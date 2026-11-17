import type { ChannelAdapter } from "#channel/adapter.js";

export const HTTP_ADAPTER_KIND = "http";

export const HTTP_ADAPTER: ChannelAdapter = {
  kind: HTTP_ADAPTER_KIND,
};
