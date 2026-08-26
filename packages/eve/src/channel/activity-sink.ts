import { z } from "#compiled/zod/index.js";

import type { ActivitySinkV1 } from "#channel/types.js";
import { EVE_ACTIVITY_ROUTE_PATTERN } from "#protocol/routes.js";
import { isReservedIpAddress } from "#shared/network-address.js";

const schema = z.object({ url: z.string().min(1), version: z.literal(1) }).strict();

export function parseActivitySink(value: unknown): ActivitySinkV1 | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Expected activitySink version 1.");
  let url: URL;
  try {
    url = new URL(parsed.data.url);
  } catch {
    throw new Error("Activity sink url must be absolute.");
  }
  const routePrefix = EVE_ACTIVITY_ROUTE_PATTERN.slice(0, -":token".length);
  const token = url.pathname.slice(url.pathname.lastIndexOf(routePrefix) + routePrefix.length);
  if (url.pathname.lastIndexOf(routePrefix) < 0 || token.length < 32) {
    throw new Error("Activity sink url must contain an opaque activity token.");
  }
  if (isReservedIpAddress(url.hostname)) {
    throw new Error("Activity sink url host must not be a private or reserved address.");
  }
  return parsed.data;
}
