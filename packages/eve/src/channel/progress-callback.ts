import { z } from "#compiled/zod/index.js";

import type { ProgressCallbackV1 } from "#channel/types.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { isReservedIpAddress } from "#shared/network-address.js";

const schema = z
  .object({ token: z.string().min(1), url: z.string().min(1), version: z.literal(1) })
  .strict();

export function parseProgressCallback(value: unknown): ProgressCallbackV1 | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Expected progressCallback version 1.");
  let url: URL;
  try {
    url = new URL(parsed.data.url);
  } catch {
    throw new Error("Progress callback url must be absolute.");
  }
  const prefix = createEveCallbackRoutePath("");
  const token = url.pathname.slice(url.pathname.lastIndexOf(prefix) + prefix.length);
  if (url.pathname.lastIndexOf(prefix) < 0 || decodeURIComponent(token) !== parsed.data.token) {
    throw new Error("Progress callback url token must match callback token.");
  }
  if (isReservedIpAddress(url.hostname))
    throw new Error("Progress callback url host must not be a private or reserved address.");
  return parsed.data;
}
