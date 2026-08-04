import { track } from "@vercel/analytics/server";
import { type AnalyticsEventName, isQueryFreeUrl } from "./events";

export const trackServerEvent = (
  request: Request,
  event: AnalyticsEventName,
  properties: Record<string, boolean | number | string>,
) => {
  // Server analytics inherits the request URL. Skip query strings rather than risk recording input.
  if (!isQueryFreeUrl(request.url)) return;
  void track(event, properties, { request });
};
