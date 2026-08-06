import { track } from "@vercel/analytics/server";
import { type AnalyticsEventName, isQueryFreeUrl } from "./events";

export const trackServerEvent = (
  request: Request,
  event: AnalyticsEventName,
  properties: Record<string, boolean | number | string>,
) => {
  // The SDK prefers Next's ambient request URL over the passed Request, so a
  // query-bearing request must be skipped rather than reconstructed.
  if (!isQueryFreeUrl(request.url)) return;
  void track(event, properties, { request });
};
